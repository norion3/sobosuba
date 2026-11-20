/**
 * sound.js
 * @version v7.7 (Sobosuba Water-Bubble Procedural Sound Engine - Phase 1)
 * @changes
 *   - 現行の iOS / GRAVITY WebView 同期ハード初期化・復帰監視・デフォルト OFF 仕様を維持したまま、AudioContext 紐づきで自動再構築するマスターチェイン（Lowpass 3200Hz → 高速ソフトリミッター → MasterGain）および共有ノイズバッファ（ensureAudioGraph）を実装
 *   - 音量 OFF 切替時の 15ms 即時フェードミュート、および全ノード終了時（onended）の自動 disconnect() とデジタルクリックノイズ防止（0.0001 下限・+20ms 停止余裕）を導入
 *   - 全8種の本家 sobosuba 風・水音シンセシス（playSoundMerge［基準 360〜190Hz・純正ペンタトニック・ローパス三角波ボディ・2次気泡・45msマイクロアルペジオ］、playSoundMergeAnticipate［吸い付き音］、playSoundCollide［45ms間引き付き水球たわみ音］、playSoundShoot(powerRatio)、playSoundHop、playSoundSelect［上段タッチ音］、playSoundGameOverZap［580ms 4連水没バブルダウン音］、ON確認水滴音）を実装
 * 
 * Web Audio APIを使用した軽量プロシージャル水音サウンドモジュール
 * 
 * 外部の音声ファイルに依存せず、気泡共鳴（上向きピッチスイープ）とローパス三角波ボディ・
 * 共有ノイズバッファによる水膜フィルタ合成を用いて、本家sobosubaのような耳に心地よい水球・水滴サウンドを
 * 動的に生成・再生します。起動時はデフォルト OFF であり、音量 ON 操作時にハード初期化を行います。
 */

let audioCtx = null;

// 現在の audioCtx に 1対1 で紐づくマスターグラフ・共有ノイズバッファ（復帰再生成時に自動破棄・再構築）
let graphCtx = null;
let masterInput = null;
let masterCompressor = null;
let masterGain = null;
let sharedNoiseBuffer = null;

// デフォルト OFF の音量状態フラグ（起動時は完全無音）
let soundEnabled = false;
let suspendTimer = null;

// 各種スロットリング・連鎖和声・同時合体アルペジオ状態管理
let lastCollideSoundTime = 0;
let lastAnticipateSoundTime = 0;
let lastSelectSoundTime = 0;
let lastMergeScheduledTime = 0;
let chainBaseFreq = 360;

const COLLIDE_THROTTLE_MS = 45;
const ANTICIPATE_THROTTLE_MS = 35;
const SELECT_THROTTLE_MS = 40;
const MASTER_GAIN_LEVEL = 0.92;
const PENTATONIC_SEMITONES = [0, 2, 4, 7, 9, 12, 14, 16, 19];

// 復帰リスナーの多重登録防止フラグ
let lifecycleListenersBound = false;

/**
 * 数値の安全クランプ
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

/**
 * 有機的な微細ピッチ揺らぎ（±rate）を返す
 * @param {number} [rate=0.02]
 * @returns {number}
 */
function pitchJitter(rate = 0.02) {
    return 1 + (Math.random() * 2 - 1) * rate;
}

/**
 * ゼリーサイズ（2〜2048+）を 0.0（最小）〜 1.0（最大）へ正規化する
 * @param {number} value
 * @returns {number}
 */
function getMergeSizeNorm(value) {
    const safeVal = Math.max(2, Number(value) || 4);
    const tier = Math.log2(safeVal) - 1; // 2 -> 0, 2048 -> 10
    return clamp(tier / 10, 0, 1);
}

/**
 * ゼリーサイズ（1〜2048+）を 0.0（最小）〜 1.0（最大）へ正規化する
 * @param {number} value
 * @returns {number}
 */
function getAnySizeNorm(value) {
    const safeVal = Math.max(1, Number(value) || 4);
    const tier = Math.log2(safeVal); // 1 -> 0, 2048 -> 11
    return clamp(tier / 11, 0, 1);
}

/**
 * 発音終了時にすべての接続ノードを確実に disconnect() するクリーンアップ登録ヘルパー
 * @param {AudioScheduledSourceNode} sourceNode
 * @param {Array<AudioNode>} nodesToDisconnect
 */
function bindAutoDisconnect(sourceNode, nodesToDisconnect) {
    if (!sourceNode) return;
    sourceNode.onended = () => {
        for (let i = 0; i < nodesToDisconnect.length; i++) {
            const node = nodesToDisconnect[i];
            if (!node) continue;
            try {
                node.disconnect();
            } catch (_err) {
                // 既に切断済みの場合は無視
            }
        }
    };
}

/**
 * 現在の AudioContext に紐づくマスターグラフキャッシュを破棄する
 */
function clearAudioGraphCache() {
    graphCtx = null;
    masterInput = null;
    masterCompressor = null;
    masterGain = null;
    sharedNoiseBuffer = null;
}

/**
 * 現在の AudioContext に紐づくマスターチェイン（Lowpass 3200Hz → 高速ソフトリミッター → MasterGain）
 * および 0.25 秒分の共有ホワイトノイズバッファを 1対1 で構築・取得する
 * @param {AudioContext} ctx
 * @returns {{ input: AudioNode, masterGain: GainNode, noiseBuffer: AudioBuffer|null } | null}
 */
function ensureAudioGraph(ctx) {
    if (!ctx || ctx.state === 'closed') return null;

    if (graphCtx === ctx && masterInput && masterGain) {
        return {
            input: masterInput,
            masterGain,
            noiseBuffer: sharedNoiseBuffer
        };
    }

    try {
        // 1. マスターローパスフィルタ（3200Hz, Q=0.55：耳に刺さる高域を丸める）
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(3200, ctx.currentTime);
        lp.Q.setValueAtTime(0.55, ctx.currentTime);

        // 2. マスターゲイン（ON時 0.92、OFF時 15ms フェードミュート制御用）
        const mGain = ctx.createGain();
        mGain.gain.setValueAtTime(soundEnabled ? MASTER_GAIN_LEVEL : 0.0001, ctx.currentTime);
        mGain.connect(ctx.destination);

        // 3. 高速ソフトリミッター（大連鎖同時発音でも音割れ・ポンピングゼロ）
        let comp = null;
        if (typeof ctx.createDynamicsCompressor === 'function') {
            comp = ctx.createDynamicsCompressor();
            comp.threshold.setValueAtTime(-6, ctx.currentTime);
            comp.knee.setValueAtTime(12, ctx.currentTime);
            comp.ratio.setValueAtTime(3.5, ctx.currentTime);
            comp.attack.setValueAtTime(0.003, ctx.currentTime);
            comp.release.setValueAtTime(0.06, ctx.currentTime);
            lp.connect(comp);
            comp.connect(mGain);
        } else {
            lp.connect(mGain);
        }

        // 4. 共有ホワイトノイズバッファ（0.25秒分・起動/復帰時1回のみ生成してゼロアロケーション再利用）
        let noiseBuf = null;
        try {
            const sampleRate = ctx.sampleRate || 44100;
            const length = Math.max(1024, Math.floor(sampleRate * 0.25));
            noiseBuf = ctx.createBuffer(1, length, sampleRate);
            const data = noiseBuf.getChannelData(0);
            for (let i = 0; i < length; i++) {
                data[i] = Math.random() * 2 - 1;
            }
        } catch (_err) {
            noiseBuf = null;
        }

        graphCtx = ctx;
        masterInput = lp;
        masterCompressor = comp;
        masterGain = mGain;
        sharedNoiseBuffer = noiseBuf;

        return {
            input: masterInput,
            masterGain,
            noiseBuffer: sharedNoiseBuffer
        };
    } catch (_err) {
        clearAudioGraphCache();
        return null;
    }
}

/**
 * 共有ホワイトノイズバッファから極短の水膜・流体ノイズを再生する共通ヘルパー
 * @param {AudioContext} ctx
 * @param {{ input: AudioNode, noiseBuffer: AudioBuffer|null }} graph
 * @param {number} startTime
 * @param {number} duration
 * @param {string} filterType - 'bandpass' | 'lowpass'
 * @param {number} startFreq
 * @param {number} endFreq
 * @param {number} q
 * @param {number} peakGain
 */
function playWaterNoiseBurst(ctx, graph, startTime, duration, filterType, startFreq, endFreq, q, peakGain) {
    if (!ctx || !graph || !graph.noiseBuffer || peakGain <= 0.001) return;

    const src = ctx.createBufferSource();
    src.buffer = graph.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.setValueAtTime(q, startTime);
    filter.frequency.setValueAtTime(Math.max(80, startFreq), startTime);
    if (Math.abs(endFreq - startFreq) > 1) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(80, endFreq), startTime + duration);
    }

    const gain = ctx.createGain();
    const attack = Math.min(0.005, duration * 0.25);
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(graph.input);

    bindAutoDisconnect(src, [src, filter, gain]);

    // 毎回バッファ内の異なる位置から読み出して機械的な反復感をなくす
    const maxOffset = Math.max(0, graph.noiseBuffer.duration - duration - 0.03);
    const offset = maxOffset > 0 ? (Math.random() * maxOffset) : 0;
    src.start(startTime, offset, duration + 0.02);
}

/**
 * 1サンプルの無音バッファを同期再生し、iOS / WebView のオーディオ出力ハードウェアをアンロックする
 * @param {AudioContext} ctx
 */
function playSilentUnlockBuffer(ctx) {
    if (!ctx || ctx.state === 'closed') return;
    try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        bindAutoDisconnect(source, [source]);
        source.start(0);
    } catch (_err) {
        // 再生不可環境でもゲーム進行を止めない
    }
}

/**
 * 音量 ON 時の軽快な2粒の水滴確認音（ハード初期化直後の発音確認を兼ねる）
 * @param {AudioContext} ctx
 */
function playConfirmOnTone(ctx) {
    if (!ctx || ctx.state === 'closed') return;
    const graph = ensureAudioGraph(ctx);
    if (!graph) return;

    try {
        const now = ctx.currentTime;
        const drops = [
            { delay: 0,     fStart: 390, fEnd: 620, dur: 0.075, peak: 0.16 },
            { delay: 0.048, fStart: 540, fEnd: 820, dur: 0.090, peak: 0.14 }
        ];

        for (let i = 0; i < drops.length; i++) {
            const d = drops[i];
            const t0 = now + d.delay;
            const tEnd = t0 + d.dur;

            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(d.fStart, t0);
            osc.frequency.exponentialRampToValueAtTime(d.fEnd, tEnd);

            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.linearRampToValueAtTime(d.peak, t0 + 0.006);
            gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

            osc.connect(gain);
            gain.connect(graph.input);
            bindAutoDisconnect(osc, [osc, gain]);

            osc.start(t0);
            osc.stop(tEnd + 0.02);
        }
    } catch (_err) {
        // 発音不可時は無視
    }
}

/**
 * タブ・別アプリ復帰時に AudioContext の再開を試みるライフサイクルリスナーを1度だけ登録する
 */
function bindAudioLifecycleListeners() {
    if (lifecycleListenersBound || typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }
    lifecycleListenersBound = true;

    const tryAutoResume = () => {
        if (!soundEnabled || !audioCtx || audioCtx.state === 'closed') return;
        if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
            try {
                const res = audioCtx.resume();
                if (res && typeof res.catch === 'function') {
                    res.catch(() => {});
                }
            } catch (_err) {
                // 自動再開が拒否された場合は次回ユーザー操作の ensureAudioRunning() / ハード初期化で復帰
            }
        }
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            tryAutoResume();
        }
    });
    window.addEventListener('pageshow', tryAutoResume);
    window.addEventListener('focus', tryAutoResume);
}

bindAudioLifecycleListeners();

/**
 * 現在の音量 ON/OFF 状態を返す
 * @returns {boolean} ON の場合は true、OFF の場合は false
 */
export function isSoundEnabled() {
    return soundEnabled;
}

/**
 * iOS / GRAVITY WebView 同期制約準拠のオーディオ・ハード初期化
 * 1. 旧 AudioContext と旧マスターグラフを退避・破棄して非同期クローズ（await せずユーザージェスチャー同期スタックを維持）
 * 2. 同一同期スタック内で新規 AudioContext と新マスターグラフを生成し、resume() ＋ 1サンプル無音バッファでハードアンロック
 * 3. オプションで音量 ON 水滴確認音を鳴らす
 * @param {boolean} [playConfirm=true] - 初期化直後にオン確認音を鳴らすかどうか
 * @returns {boolean} 新規 AudioContext の構築に成功した場合は true
 */
export function hardResetAudioContext(playConfirm = true) {
    const AudioContextClass = (typeof window !== 'undefined')
        ? (window.AudioContext || window.webkitAudioContext)
        : null;
    if (!AudioContextClass) return false;

    if (suspendTimer) {
        clearTimeout(suspendTimer);
        suspendTimer = null;
    }

    // 1. 旧コンテキストおよび紐づくノードキャッシュを退避・破棄し、await せずにバックグラウンドでクローズ
    const oldCtx = audioCtx;
    audioCtx = null;
    clearAudioGraphCache();

    if (oldCtx && oldCtx.state !== 'closed') {
        try {
            const closePromise = oldCtx.close();
            if (closePromise && typeof closePromise.catch === 'function') {
                closePromise.catch(() => {});
            }
        } catch (_err) {
            // 既にクローズ済み等の例外は無視
        }
    }

    // 2. 同一同期スタック内で新規 AudioContext とマスターグラフを構築し、即座に resume() ＋ 無音バッファ再生でアンロック
    try {
        const nextCtx = new AudioContextClass();
        audioCtx = nextCtx;
        lastCollideSoundTime = 0;
        lastAnticipateSoundTime = 0;
        lastSelectSoundTime = 0;
        lastMergeScheduledTime = 0;
        chainBaseFreq = 360;

        if (nextCtx.state === 'suspended' || nextCtx.state === 'interrupted') {
            const resumePromise = nextCtx.resume();
            if (resumePromise && typeof resumePromise.catch === 'function') {
                resumePromise.catch(() => {});
            }
        }

        playSilentUnlockBuffer(nextCtx);
        ensureAudioGraph(nextCtx);

        // 3. オン確認水滴音でハード出力の再開をユーザーへ明確にフィードバック
        if (playConfirm) {
            playConfirmOnTone(nextCtx);
        }
        return true;
    } catch (_err) {
        audioCtx = null;
        clearAudioGraphCache();
        return false;
    }
}

/**
 * 音量 ON 状態かつユーザー操作／復帰時に AudioContext が稼働中であることを保証する自動リカバリ関数
 * （デフォルト OFF 時は無断で AudioContext を起動しない）
 */
export function ensureAudioRunning() {
    if (!soundEnabled) return;

    const AudioContextClass = (typeof window !== 'undefined')
        ? (window.AudioContext || window.webkitAudioContext)
        : null;
    if (!AudioContextClass) return;

    if (!audioCtx || audioCtx.state === 'closed') {
        hardResetAudioContext(false);
        return;
    }

    // iOS 特有の 'interrupted' 状態または 'suspended' 状態なら再開＋無音バッファアンロックを試行
    if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
        try {
            const res = audioCtx.resume();
            if (res && typeof res.catch === 'function') {
                res.catch(() => {});
            }
            playSilentUnlockBuffer(audioCtx);
        } catch (_err) {
            // 復帰失敗時はハード初期化へフォールバック
            hardResetAudioContext(false);
        }
    }

    ensureAudioGraph(audioCtx);
}

/**
 * 音量の ON / OFF を設定する
 * ON 切替時は必ず同期ハード初期化（hardResetAudioContext）を実行して別画面復帰後の無音化を確実に解消する
 * OFF 切替時は 15ms で高速フェードミュートして再生中の残響をプチッ音なしで即座に遮断する
 * @param {boolean} enabled - true で ON、false で OFF
 * @returns {boolean} 更新後の音量状態
 */
export function setSoundEnabled(enabled) {
    const nextEnabled = Boolean(enabled);
    soundEnabled = nextEnabled;

    if (suspendTimer) {
        clearTimeout(suspendTimer);
        suspendTimer = null;
    }

    if (nextEnabled) {
        hardResetAudioContext(true);
    } else if (audioCtx && audioCtx.state === 'running') {
        const targetCtx = audioCtx;
        try {
            if (masterGain && graphCtx === targetCtx) {
                const now = targetCtx.currentTime;
                masterGain.gain.cancelScheduledValues(now);
                masterGain.gain.setValueAtTime(Math.max(0.0001, masterGain.gain.value), now);
                masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.015);
            }
        } catch (_err) {
            // 無視
        }

        // 15ms フェードアウト完了後に安全に suspend() してハードウェア消費電力を抑える
        suspendTimer = setTimeout(() => {
            suspendTimer = null;
            if (!soundEnabled && audioCtx === targetCtx && targetCtx.state === 'running') {
                try {
                    const suspendPromise = targetCtx.suspend();
                    if (suspendPromise && typeof suspendPromise.catch === 'function') {
                        suspendPromise.catch(() => {});
                    }
                } catch (_err) {
                    // 無視
                }
            }
        }, 25);
    }

    return soundEnabled;
}

/**
 * 音量の ON / OFF をトグルし、新しい状態を返す
 * @returns {boolean} トグル後の音量状態（true: ON / false: OFF）
 */
export function toggleSound() {
    return setSoundEnabled(!soundEnabled);
}

/**
 * オーディオコンテキストの初期化（既存呼び出し互換）
 * デフォルト OFF の間は起動せず、ON 状態の場合のみ稼働を保証する
 */
export function initSound() {
    if (!soundEnabled) return;
    ensureAudioRunning();
}

/**
 * 全効果音共通の再生可否ガード（ミュート・未初期化・中断状態の安全制御 ＆ マスターグラフ確保）
 * @returns {{ ctx: AudioContext, graph: { input: AudioNode, masterGain: GainNode, noiseBuffer: AudioBuffer|null } } | null}
 */
function getPlayableAudio() {
    if (!soundEnabled || !audioCtx || audioCtx.state === 'closed') return null;

    if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
        try {
            const res = audioCtx.resume();
            if (res && typeof res.catch === 'function') {
                res.catch(() => {});
            }
        } catch (_err) {
            return null;
        }
    }

    const graph = ensureAudioGraph(audioCtx);
    if (!graph) return null;

    return { ctx: audioCtx, graph };
}

/**
 * 上段ゼリー選択時の極小水球タッチ音（「ぷにっ」）
 * @param {number} [sizeValue=4] - 選択したゼリーの数値
 */
export function playSoundSelect(sizeValue = 4) {
    const audio = getPlayableAudio();
    if (!audio) return;

    const nowMs = performance.now();
    if (nowMs - lastSelectSoundTime < SELECT_THROTTLE_MS) return;
    lastSelectSoundTime = nowMs;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const sizeNorm = getAnySizeNorm(sizeValue);
    const j = pitchJitter(0.02);

    // 小塊は少し軽やか、大塊は少し落ち着いた丸い「ぷにっ」
    const startFreq = (340 - sizeNorm * 80) * j;
    const endFreq = (490 - sizeNorm * 100) * j;
    const dur = 0.036;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + dur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + dur + 0.02);
}

/**
 * 発射音（そっと落とし「ぽとん」〜 通常ショット「しゅぽっ」）
 * @param {number} [powerRatio=0.5] - 発射強度比率（0.0 = そっと落とし 〜 1.0 = 全力ショット）
 */
export function playSoundShoot(powerRatio = 0.5) {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const p = clamp(Number(powerRatio), 0, 1);
    const safePower = Number.isFinite(p) ? p : 0.5;
    const j = pitchJitter(0.02);

    // 1. 水球リリース音（そっと落とし: 210→300Hz の丸い「ぽとん」、強ショット: 230→520Hz の「しゅぽっ」）
    const startFreq = (210 + safePower * 20) * j;
    const endFreq = (300 + safePower * 220) * j;
    const dur = 0.055 + safePower * 0.012;
    const peakGain = 0.16 + safePower * 0.08;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + dur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + dur + 0.02);

    // 2. 水膜を切る柔らかいバンドパス流体スウィッシュ（ショット強度に応じて付加）
    const swishGain = 0.012 + safePower * 0.058;
    playWaterNoiseBurst(
        ctx,
        graph,
        now,
        0.042,
        'bandpass',
        750 * j,
        (1150 + safePower * 700) * j,
        2.2,
        swishGain
    );
}

/**
 * 上段飛び越えホップ音（Bar-Hop：2段バブル・ホップ音「ぽよんっ」）
 */
export function playSoundHop() {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const j = pitchJitter(0.02);

    // 1. 跳ね上がり主音（260→210Hz の 14ms 溜め → 610Hz へ 90ms で軽やかに上昇）
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    const dur1 = 0.104;

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(260 * j, now);
    osc1.frequency.exponentialRampToValueAtTime(210 * j, now + 0.014);
    osc1.frequency.exponentialRampToValueAtTime(610 * j, now + dur1);

    gain1.gain.setValueAtTime(0.0001, now);
    gain1.gain.linearRampToValueAtTime(0.22, now + 0.012);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + dur1 + 0.032);

    osc1.connect(gain1);
    gain1.connect(graph.input);
    bindAutoDisconnect(osc1, [osc1, gain1]);

    osc1.start(now);
    osc1.stop(now + dur1 + 0.052);

    // 2. 22ms 遅れの軽やか水滴ハーモニック（500→880Hz、音量 22% 相当）
    const t2 = now + 0.022;
    const dur2 = 0.062;
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();

    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(500 * j, t2);
    osc2.frequency.exponentialRampToValueAtTime(880 * j, t2 + dur2);

    gain2.gain.setValueAtTime(0.0001, t2);
    gain2.gain.linearRampToValueAtTime(0.048, t2 + 0.006);
    gain2.gain.exponentialRampToValueAtTime(0.0001, t2 + dur2);

    osc2.connect(gain2);
    gain2.connect(graph.input);
    bindAutoDisconnect(osc2, [osc2, gain2]);

    osc2.start(t2);
    osc2.stop(t2 + dur2 + 0.02);
}

/**
 * 接触音（異数字衝突・高速壁/床着地時の水風船たわみ共鳴音「ぷよっ」「ぽこん」「どぷっ」）
 * 45ms グローバル間引きおよびスマホ内蔵スピーカー最適化帯域（360〜165Hz）に対応
 * @param {number} [intensity=0.5] - 衝突の強さ（0.0 〜 1.0）
 * @param {number} [jellyValue=4] - 衝突したゼリーの数値（小さいほど高音、大きいほど低音）
 */
export function playSoundCollide(intensity = 0.5, jellyValue = 4) {
    const audio = getPlayableAudio();
    if (!audio || intensity < 0.1) return;

    // 45ms 以内の連続発火を制限し、大合体衝撃波時の同時衝突スパイクを防止
    const nowMs = performance.now();
    if (nowMs - lastCollideSoundTime < COLLIDE_THROTTLE_MS) return;
    lastCollideSoundTime = nowMs;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const clampedIntensity = clamp(Number(intensity) || 0.5, 0.1, 1.0);
    const sizeNorm = getAnySizeNorm(jellyValue); // 0.0(最小) 〜 1.0(最大)
    const j = pitchJitter(0.025);

    // サイズ帯域 360Hz（小塊）〜 165Hz（大塊）
    const baseFreq = (360 - sizeNorm * 195) * j;
    const dipDur = 0.018;
    const riseDur = 0.044 + sizeNorm * 0.024;
    const totalDur = dipDur + riseDur;

    // 接触瞬間に沈み（1.0f -> 0.80f）→ 水圧で押し戻る（-> 1.16f）水球たわみ波形
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(100, baseFreq * 0.80), now + dipDur);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.16, now + totalDur);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1450 - sizeNorm * 700, now);
    filter.Q.setValueAtTime(0.8, now);

    const peakGain = 0.075 + clampedIntensity * 0.165; // 0.08 〜 0.24 の控えめ帯域
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + totalDur);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, filter, gain]);

    osc.start(now);
    osc.stop(now + totalDur + 0.02);

    // 極小の濡れた接触ノイズ（880Hz, 12ms）
    playWaterNoiseBurst(
        ctx,
        graph,
        now,
        0.012,
        'bandpass',
        880 * j,
        880 * j,
        1.8,
        0.015 + clampedIntensity * 0.028
    );
}

/**
 * 同数字接触・吸い付きの間開始時の極小水膜結合音（「ちゅぷっ」）
 * @param {number} [sizeValue=4] - 合体元のゼリー数値
 */
export function playSoundMergeAnticipate(sizeValue = 4) {
    const audio = getPlayableAudio();
    if (!audio) return;

    const nowMs = performance.now();
    if (nowMs - lastAnticipateSoundTime < ANTICIPATE_THROTTLE_MS) return;
    lastAnticipateSoundTime = nowMs;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const sizeNorm = getAnySizeNorm(sizeValue);
    const j = pitchJitter(0.02);

    const baseFreq = (360 - sizeNorm * 170) * j;
    const dur = 0.046;

    // 1.15f → 0.86f へ吸い込まれる水膜結合音
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * 1.15, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(120, baseFreq * 0.86), now + dur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.10, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + dur + 0.02);

    // 極小ローパス水膜ノイズ（950Hz, 18ms）
    playWaterNoiseBurst(ctx, graph, now, 0.018, 'lowpass', 950 * j, 620 * j, 0.9, 0.036);
}

/**
 * 合体音（本家 sobosuba 風・3層水球バブル合成「ぽくんっ…ぴく」／大塊「ぼぷぅんっ…ぽく」）
 * 基準帯域 360〜190Hz、連鎖時は開始サイズ基準の純正ペンタトニック上昇、同時合体 45ms マイクロアルペジオ対応
 * @param {number} [chainCount=0] - 現在の連鎖回数（0始まり）
 * @param {number} [mergedValue=4] - 合体後に生成されたゼリーの数値（省略時は互換デフォルト 4）
 */
export function playSoundMerge(chainCount = 0, mergedValue = 4) {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const safeChain = Math.max(0, Math.floor(Number(chainCount) || 0));
    const sizeNorm = getMergeSizeNorm(mergedValue); // 0.0(2) 〜 1.0(2048+)
    const j = pitchJitter(0.02);

    // 同時複数合体時は 45ms ずつ微シフト（最大遅延 135ms）して粒立ちの良いアルペジオにする
    let startTime = now;
    if (lastMergeScheduledTime > now - 0.044) {
        startTime = Math.min(now + 0.135, lastMergeScheduledTime + 0.045);
    }
    lastMergeScheduledTime = startTime;

    // 連鎖開始（chainCount === 0）でサイズ基準周波数（360〜190Hz）を記憶し、
    // 連鎖中は記憶した基準軸から純正ペンタトニックで駆け上がる（サイズ増加による音痴化を防止）
    const sizeBaseFreq = 360 - sizeNorm * 170;
    if (safeChain === 0) {
        chainBaseFreq = sizeBaseFreq;
    }

    const stepIndex = Math.min(PENTATONIC_SEMITONES.length - 1, safeChain);
    const semitones = PENTATONIC_SEMITONES[stepIndex];
    const pitchRatio = Math.pow(2, semitones / 12);
    const f = chainBaseFreq * pitchRatio * j;

    // --- 層 1：主気泡サイン波（0.72f → 1.62f、上限 1800Hz、52〜92ms 指数上昇） ---
    const sweepDur = 0.052 + sizeNorm * 0.040;
    const decayDur = 0.145 + sizeNorm * 0.125;
    const mainStartFreq = Math.max(110, f * 0.72);
    const mainEndFreq = Math.min(1800, f * 1.62);
    const mainPeak = 0.34 + sizeNorm * 0.06;

    const mainOsc = ctx.createOscillator();
    const mainGain = ctx.createGain();
    mainOsc.type = 'sine';
    mainOsc.frequency.setValueAtTime(mainStartFreq, startTime);
    mainOsc.frequency.exponentialRampToValueAtTime(mainEndFreq, startTime + sweepDur);

    mainGain.gain.setValueAtTime(0.0001, startTime);
    mainGain.gain.linearRampToValueAtTime(mainPeak, startTime + 0.006);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + decayDur);

    mainOsc.connect(mainGain);
    mainGain.connect(graph.input);
    bindAutoDisconnect(mainOsc, [mainOsc, mainGain]);

    mainOsc.start(startTime);
    mainOsc.stop(startTime + decayDur + 0.02);

    // --- 層 2：水球ボディ（0.75f ローパス三角波 680Hz：スマホ内蔵スピーカーでも大塊の深い重みを表現） ---
    const bodyBaseFreq = Math.max(125, sizeBaseFreq * 0.75 * j);
    const bodyDur = 0.13 + sizeNorm * 0.12;
    const bodyPeak = 0.055 + sizeNorm * 0.145;

    const bodyOsc = ctx.createOscillator();
    const bodyFilter = ctx.createBiquadFilter();
    const bodyGain = ctx.createGain();

    bodyOsc.type = 'triangle';
    bodyOsc.frequency.setValueAtTime(bodyBaseFreq * 0.92, startTime);
    bodyOsc.frequency.exponentialRampToValueAtTime(bodyBaseFreq * 1.12, startTime + sweepDur * 0.85);

    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.setValueAtTime(680, startTime);
    bodyFilter.Q.setValueAtTime(0.7, startTime);

    bodyGain.gain.setValueAtTime(0.0001, startTime);
    bodyGain.gain.linearRampToValueAtTime(bodyPeak, startTime + 0.012);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, startTime + bodyDur);

    bodyOsc.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(graph.input);
    bindAutoDisconnect(bodyOsc, [bodyOsc, bodyFilter, bodyGain]);

    bodyOsc.start(startTime);
    bodyOsc.stop(startTime + bodyDur + 0.02);

    // --- 層 3：2次小気泡（28〜44ms 遅れ：1.35f → 1.95f、上限 2200Hz）＋ 極短水膜ノイズ ---
    const subDelay = 0.028 + sizeNorm * 0.016;
    const subStart = startTime + subDelay;
    const subDur = 0.055 + sizeNorm * 0.025;
    const subStartFreq = Math.min(2000, f * 1.35);
    const subEndFreq = Math.min(2200, Math.max(subStartFreq * 1.05, f * 1.95));
    const subPeak = mainPeak * 0.26;

    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(subStartFreq, subStart);
    subOsc.frequency.exponentialRampToValueAtTime(subEndFreq, subStart + subDur);

    subGain.gain.setValueAtTime(0.0001, subStart);
    subGain.gain.linearRampToValueAtTime(subPeak, subStart + 0.005);
    subGain.gain.exponentialRampToValueAtTime(0.0001, subStart + subDur);

    subOsc.connect(subGain);
    subGain.connect(graph.input);
    bindAutoDisconnect(subOsc, [subOsc, subGain]);

    subOsc.start(subStart);
    subOsc.stop(subStart + subDur + 0.02);

    // 極短バンドパス水膜ノイズ（1350Hz, 16ms）
    playWaterNoiseBurst(ctx, graph, startTime, 0.016, 'bandpass', 1350 * j, 1650 * j, 2.0, 0.032);
}

/**
 * ゲームオーバー演出音（580ms 4連水没バブルダウン音「ぶく・ぶく・ぶく・どぷぅん…」）
 * リザルト表示遅延（550ms）と完全同期。既存呼び出し互換のため関数名 playSoundGameOverZap を維持。
 */
export function playSoundGameOverZap() {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;

    // 1. 4連の水没気泡ダウン（380 → 285 → 215 → 155Hz、各気泡に水らしい短い上向き「ぽくっ」スイープ）
    const bubbles = [
        { delay: 0.000, freq: 380, dur: 0.082, peak: 0.24 },
        { delay: 0.095, freq: 285, dur: 0.092, peak: 0.23 },
        { delay: 0.205, freq: 215, dur: 0.105, peak: 0.22 },
        { delay: 0.325, freq: 155, dur: 0.140, peak: 0.20 }
    ];

    for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        const t0 = now + b.delay;
        const tEnd = t0 + b.dur;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(b.freq * 0.82, t0);
        osc.frequency.exponentialRampToValueAtTime(b.freq * 1.28, t0 + b.dur * 0.65);
        osc.frequency.exponentialRampToValueAtTime(b.freq * 0.94, tEnd);

        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(b.peak, t0 + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

        osc.connect(gain);
        gain.connect(graph.input);
        bindAutoDisconnect(osc, [osc, gain]);

        osc.start(t0);
        osc.stop(tEnd + 0.02);
    }

    // 2. 4粒目に重なって水底へ沈みきる深い水没ローパス三角波ボディ（145 → 105Hz、580ms 収束）
    const bodyStart = now + 0.280;
    const bodyEnd = now + 0.580;

    const bodyOsc = ctx.createOscillator();
    const bodyFilter = ctx.createBiquadFilter();
    const bodyGain = ctx.createGain();

    bodyOsc.type = 'triangle';
    bodyOsc.frequency.setValueAtTime(145, bodyStart);
    bodyOsc.frequency.exponentialRampToValueAtTime(105, bodyEnd);

    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.setValueAtTime(480, bodyStart);
    bodyFilter.Q.setValueAtTime(0.7, bodyStart);

    bodyGain.gain.setValueAtTime(0.0001, bodyStart);
    bodyGain.gain.linearRampToValueAtTime(0.22, bodyStart + 0.045);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, bodyEnd);

    bodyOsc.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(graph.input);
    bindAutoDisconnect(bodyOsc, [bodyOsc, bodyFilter, bodyGain]);

    bodyOsc.start(bodyStart);
    bodyOsc.stop(bodyEnd + 0.02);

    // 3. 沈み込みの柔らかい水流ノイズ
    playWaterNoiseBurst(ctx, graph, now + 0.02, 0.22, 'lowpass', 720, 260, 0.7, 0.045);
}