/**
 * sound.js
 * @version v7.8 (Healing Water-Drop ASMR & Procedural Water Reverb - Phase 1)
 * @changes
 *   - ensureAudioGraph(ctx) へ AudioContext 紐づきで自動再構築されるプロシージャル「静かな水辺リバーブ（ConvolverNode・ステレオ 0.65秒 指数減衰IR・Dry 78% / Wet 26%・2400Hz ローパス）」を追加し、マスターローパスを 4200Hz (Q=0.5) へ調整
 *   - ゴムの水風船感を招いていた長いピッチスイープ・Dip-Rise・三角波・中域摩擦ノイズを徹底排除し、全8種の効果音（playSoundMerge / playSoundCollide / playSoundMergeAnticipate / playSoundShoot / playSoundHop / playSoundSelect / playSoundGameOverZap / ON確認音）を「短い水滴スイープ＋澄んだ純サイン波余韻＋高透明帯域（520〜260Hz）」の本家 sobosuba 風・癒し水音ASMRへ刷新
 * 
 * Web Audio APIを使用した軽量プロシージャル癒し水音サウンドモジュール
 * 
 * 外部の音声ファイルに依存せず、短い水滴ピッチスイープ・澄んだ純サイン波余韻・
 * プロシージャル水辺リバーブを用いて、本家sobosubaのような静かで耳に心地よい水滴・水琴窟ASMRサウンドを
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
let chainBaseFreq = 520;

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
 * 静かな水辺リバーブ用のステレオ 0.65 秒 指数減衰インパルス応答（IR）バッファを生成する
 * @param {AudioContext} ctx
 * @returns {AudioBuffer|null}
 */
function createWaterReverbIR(ctx) {
    try {
        const sampleRate = ctx.sampleRate || 44100;
        const duration = 0.65;
        const length = Math.max(2048, Math.floor(sampleRate * duration));
        const irBuffer = ctx.createBuffer(2, length, sampleRate);

        for (let ch = 0; ch < 2; ch++) {
            const data = irBuffer.getChannelData(ch);
            // わずかな初期プリディレイ（約 8ms）後に滑らかに立ち上がり指数減衰させる
            const preDelaySamples = Math.floor(sampleRate * 0.008);
            const fadeInSamples = Math.floor(sampleRate * 0.018);
            let prev = 0;

            for (let i = 0; i < length; i++) {
                if (i < preDelaySamples) {
                    data[i] = 0;
                    continue;
                }
                const t = (i - preDelaySamples) / Math.max(1, length - preDelaySamples);
                const fadeIn = Math.min(1, (i - preDelaySamples) / Math.max(1, fadeInSamples));
                const decay = Math.pow(1 - t, 3.2) * Math.exp(-t * 2.4);
                // 1次平滑化でざらつきのないシルク状の残響を生成
                const raw = (Math.random() * 2 - 1);
                prev = prev * 0.45 + raw * 0.55;
                data[i] = prev * decay * fadeIn;
            }
        }
        return irBuffer;
    } catch (_err) {
        return null;
    }
}

/**
 * 現在の AudioContext に紐づくマスターチェイン
 * （合流入力 → Dry 78% ＋ Wet 26% 水辺リバーブ [0.65s IR → Lowpass 2400Hz] → Master Lowpass 4200Hz → 高速ソフトリミッター → MasterGain）
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
        const now = ctx.currentTime;

        // 0. 各効果音の合流バス
        const inputBus = ctx.createGain();
        inputBus.gain.setValueAtTime(1.0, now);

        // 1. マスターローパスフィルタ（4200Hz, Q=0.5：水滴の透明なきらめきを残しつつ耳に刺さる金属域だけカット）
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(4200, now);
        lp.Q.setValueAtTime(0.5, now);

        // 2. パラレル Dry（78%）＋ Wet（26%：静かな水辺リバーブ → 2400Hz ローパス）
        const dryGain = ctx.createGain();
        dryGain.gain.setValueAtTime(0.78, now);
        inputBus.connect(dryGain);
        dryGain.connect(lp);

        if (typeof ctx.createConvolver === 'function') {
            const irBuffer = createWaterReverbIR(ctx);
            if (irBuffer) {
                const convolver = ctx.createConvolver();
                convolver.buffer = irBuffer;

                const wetFilter = ctx.createBiquadFilter();
                wetFilter.type = 'lowpass';
                wetFilter.frequency.setValueAtTime(2400, now);
                wetFilter.Q.setValueAtTime(0.5, now);

                const wetGain = ctx.createGain();
                wetGain.gain.setValueAtTime(0.26, now);

                inputBus.connect(convolver);
                convolver.connect(wetFilter);
                wetFilter.connect(wetGain);
                wetGain.connect(lp);
            }
        }

        // 3. マスターゲイン（ON時 0.92、OFF時 15ms フェードミュート制御用）
        const mGain = ctx.createGain();
        mGain.gain.setValueAtTime(soundEnabled ? MASTER_GAIN_LEVEL : 0.0001, now);
        mGain.connect(ctx.destination);

        // 4. 高速ソフトリミッター（大連鎖同時発音でも音割れ・ポンピングゼロ）
        let comp = null;
        if (typeof ctx.createDynamicsCompressor === 'function') {
            comp = ctx.createDynamicsCompressor();
            comp.threshold.setValueAtTime(-6, now);
            comp.knee.setValueAtTime(12, now);
            comp.ratio.setValueAtTime(3.5, now);
            comp.attack.setValueAtTime(0.003, now);
            comp.release.setValueAtTime(0.06, now);
            lp.connect(comp);
            comp.connect(mGain);
        } else {
            lp.connect(mGain);
        }

        // 5. 共有ホワイトノイズバッファ（0.25秒分・起動/復帰時1回のみ生成してゼロアロケーション再利用）
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
        masterInput = inputBus;
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
 * 共有ホワイトノイズバッファから極小の高域しずく粒・清流スウィッシュを再生する共通ヘルパー
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
    const attack = Math.min(0.004, duration * 0.25);
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
 * 音量 ON 時の澄んだ2粒の水琴窟雫確認音（ハード初期化直後の発音確認を兼ねる）
 * @param {AudioContext} ctx
 */
function playConfirmOnTone(ctx) {
    if (!ctx || ctx.state === 'closed') return;
    const graph = ensureAudioGraph(ctx);
    if (!graph) return;

    try {
        const now = ctx.currentTime;
        const drops = [
            { delay: 0,     fStart: 523, fEnd: 659, sweep: 0.024, dur: 0.130, peak: 0.14 },
            { delay: 0.052, fStart: 659, fEnd: 784, sweep: 0.026, dur: 0.160, peak: 0.13 }
        ];

        for (let i = 0; i < drops.length; i++) {
            const d = drops[i];
            const t0 = now + d.delay;
            const tEnd = t0 + d.dur;

            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(d.fStart, t0);
            osc.frequency.exponentialRampToValueAtTime(d.fEnd, t0 + d.sweep);

            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.linearRampToValueAtTime(d.peak, t0 + 0.005);
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
        chainBaseFreq = 520;

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
 * 上段ゼリー選択時の極小・高透明な雫音（「ぴく」）
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
    const j = pitchJitter(0.018);

    // 水面に指先がそっと触れたような極小雫音（520〜360Hz → +18%、22ms上昇、48ms余韻）
    const startFreq = (520 - sizeNorm * 160) * j;
    const endFreq = startFreq * 1.18;
    const sweepDur = 0.022;
    const totalDur = 0.048;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + sweepDur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.06, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + totalDur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + totalDur + 0.02);
}

/**
 * 発射音（そっと落とし「ぽとん」〜 通常ショット「さらっ」）
 * @param {number} [powerRatio=0.5] - 発射強度比率（0.0 = そっと落とし 〜 1.0 = 全力ショット）
 */
export function playSoundShoot(powerRatio = 0.5) {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const p = clamp(Number(powerRatio), 0, 1);
    const safePower = Number.isFinite(p) ? p : 0.5;
    const j = pitchJitter(0.018);

    // そっと落とし: 340→430Hz (24ms上昇, 75ms余韻, 0.11)、強ショット: 360→560Hz (30ms上昇)
    const startFreq = (340 + safePower * 20) * j;
    const endFreq = (430 + safePower * 130) * j;
    const sweepDur = 0.024 + safePower * 0.006;
    const totalDur = 0.075 + safePower * 0.015;
    const peakGain = 0.11 + safePower * 0.05;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + sweepDur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + totalDur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + totalDur + 0.02);

    // 強ショット時のみ柔らかな清流スウィッシュ（1400→2600Hz, 30ms, 最大0.028）を薄く付加
    const swishGain = safePower * 0.028;
    if (swishGain > 0.002) {
        playWaterNoiseBurst(
            ctx,
            graph,
            now,
            0.030,
            'bandpass',
            1400 * j,
            2600 * j,
            2.4,
            swishGain
        );
    }
}

/**
 * 上段飛び越えホップ音（Bar-Hop：2粒の澄んだ水滴が軽やかに跳ねる音「ぽろりん」）
 */
export function playSoundHop() {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const j = pitchJitter(0.018);

    // ゴムの溜め（音程下がり）を撤廃し、澄んだ2粒の水滴が軽やかに跳ねる構成
    const drops = [
        { delay: 0.000, fStart: 390, fEnd: 520, sweep: 0.022, dur: 0.088, peak: 0.14 },
        { delay: 0.028, fStart: 520, fEnd: 700, sweep: 0.026, dur: 0.115, peak: 0.15 }
    ];

    for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        const t0 = now + d.delay;
        const tEnd = t0 + d.dur;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(d.fStart * j, t0);
        osc.frequency.exponentialRampToValueAtTime(d.fEnd * j, t0 + d.sweep);

        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(d.peak, t0 + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

        osc.connect(gain);
        gain.connect(graph.input);
        bindAutoDisconnect(osc, [osc, gain]);

        osc.start(t0);
        osc.stop(tEnd + 0.02);
    }
}

/**
 * 接触音（異数字衝突・高速壁/床着地時の静かな水滴音「ぽちゃ」「ころん」「こぽっ」）
 * ゴムの Dip-Rise を撤廃し、短い上向きスイープ＋澄んだ純サイン波余韻と 45ms 間引きで癒し感を維持
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
    const j = pitchJitter(0.022);

    // サイズ帯域 560Hz（小）〜 270Hz（大）：0.84f → 1.16f へ 18〜26ms だけ澄んで上がり、58〜88ms で静かに消える
    const baseFreq = (560 - sizeNorm * 290) * j;
    const sweepDur = 0.018 + sizeNorm * 0.008;
    const totalDur = 0.058 + sizeNorm * 0.030;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * 0.84, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.16, now + sweepDur);

    const peakGain = 0.055 + clampedIntensity * 0.10; // 0.055 〜 0.155 の静かで上品なバランス
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + totalDur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + totalDur + 0.02);

    // 極小の高域しずく粒（2200Hz, 7ms, 最大 0.012）
    playWaterNoiseBurst(
        ctx,
        graph,
        now,
        0.007,
        'bandpass',
        2200 * j,
        2450 * j,
        2.5,
        0.004 + clampedIntensity * 0.008
    );
}

/**
 * 同数字接触・吸い付きの間開始時の極小水滴吸い込み音（「くぷ」「しゅく」）
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
    const j = pitchJitter(0.018);

    // 1.08f → 0.90f へ 28ms でそっと吸い込む極小の純サイン波（ノイズなし・直後の合体音の透明感を際立たせる）
    const baseFreq = (520 - sizeNorm * 240) * j;
    const dur = 0.028;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * 1.08, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(150, baseFreq * 0.90), now + dur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.065, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + dur + 0.02);
}

/**
 * 合体音（本家 sobosuba 準拠・水滴ASMR／水琴窟合成「ぽろんっ…ぴく」／大塊「こぽぉんっ…ぽろ」）
 * 基準帯域 520〜260Hz、短い水滴スイープ＋澄んだ純サイン波余韻、純正ペンタトニック連鎖上昇、45msマイクロアルペジオ対応
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
    const j = pitchJitter(0.018);

    // 同時複数合体時は 45ms ずつ微シフト（最大遅延 135ms）して粒立ちの良いアルペジオにする
    let startTime = now;
    if (lastMergeScheduledTime > now - 0.044) {
        startTime = Math.min(now + 0.135, lastMergeScheduledTime + 0.045);
    }
    lastMergeScheduledTime = startTime;

    // 連鎖開始（chainCount === 0）でサイズ基準周波数（520〜260Hz）を記憶し、
    // 連鎖中は記憶した基準軸から純正ペンタトニックで澄んで駆け上がる
    const sizeBaseFreq = 520 - sizeNorm * 260;
    if (safeChain === 0) {
        chainBaseFreq = sizeBaseFreq;
    }

    const stepIndex = Math.min(PENTATONIC_SEMITONES.length - 1, safeChain);
    const semitones = PENTATONIC_SEMITONES[stepIndex];
    const pitchRatio = Math.pow(2, semitones / 12);
    const f = chainBaseFreq * pitchRatio * j;

    // --- 層 1：主水滴（純サイン波：最初の 22〜36ms だけ 0.78f → 1.26f へ澄んで上昇し、以後音程固定で 170〜290ms 減衰） ---
    const sweepDur = 0.022 + sizeNorm * 0.014;
    const decayDur = 0.170 + sizeNorm * 0.120;
    const mainStartFreq = Math.max(155, f * 0.78);
    const mainEndFreq = Math.min(1950, f * 1.26);
    const mainPeak = 0.28 + sizeNorm * 0.05;

    const mainOsc = ctx.createOscillator();
    const mainGain = ctx.createGain();
    mainOsc.type = 'sine';
    mainOsc.frequency.setValueAtTime(mainStartFreq, startTime);
    mainOsc.frequency.exponentialRampToValueAtTime(mainEndFreq, startTime + sweepDur);

    mainGain.gain.setValueAtTime(0.0001, startTime);
    mainGain.gain.linearRampToValueAtTime(mainPeak, startTime + 0.005);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + decayDur);

    mainOsc.connect(mainGain);
    mainGain.connect(graph.input);
    bindAutoDisconnect(mainOsc, [mainOsc, mainGain]);

    mainOsc.start(startTime);
    mainOsc.stop(startTime + decayDur + 0.02);

    // --- 層 2：水底の深み（濁りのない純サイン波オクターブ下 0.5f・下限 155Hz、大塊ほど柔らかく添える） ---
    const bodyFreq = Math.max(155, mainEndFreq * 0.5);
    const bodyDur = 0.160 + sizeNorm * 0.115;
    const bodyPeak = 0.035 + sizeNorm * 0.075; // 0.035 〜 0.11

    const bodyOsc = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    bodyOsc.type = 'sine';
    bodyOsc.frequency.setValueAtTime(Math.max(145, bodyFreq * 0.90), startTime);
    bodyOsc.frequency.exponentialRampToValueAtTime(bodyFreq, startTime + sweepDur * 0.95);

    bodyGain.gain.setValueAtTime(0.0001, startTime);
    bodyGain.gain.linearRampToValueAtTime(bodyPeak, startTime + 0.010);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, startTime + bodyDur);

    bodyOsc.connect(bodyGain);
    bodyGain.connect(graph.input);
    bindAutoDisconnect(bodyOsc, [bodyOsc, bodyGain]);

    bodyOsc.start(startTime);
    bodyOsc.stop(startTime + bodyDur + 0.02);

    // --- 層 3：2次小雫（38〜56ms 遅れ：1.45f → 1.85f、18ms上昇、上限 2400Hz、音量 20%）＋ 極小高域しずく粒 ---
    const subDelay = 0.038 + sizeNorm * 0.018;
    const subStart = startTime + subDelay;
    const subSweep = 0.018;
    const subDur = 0.068 + sizeNorm * 0.026;
    const subStartFreq = Math.min(2100, f * 1.45);
    const subEndFreq = Math.min(2400, Math.max(subStartFreq * 1.05, f * 1.85));
    const subPeak = mainPeak * 0.20;

    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(subStartFreq, subStart);
    subOsc.frequency.exponentialRampToValueAtTime(subEndFreq, subStart + subSweep);

    subGain.gain.setValueAtTime(0.0001, subStart);
    subGain.gain.linearRampToValueAtTime(subPeak, subStart + 0.004);
    subGain.gain.exponentialRampToValueAtTime(0.0001, subStart + subDur);

    subOsc.connect(subGain);
    subGain.connect(graph.input);
    bindAutoDisconnect(subOsc, [subOsc, subGain]);

    subOsc.start(subStart);
    subOsc.stop(subStart + subDur + 0.02);

    // 水面に触れた瞬間の極小高域しずく粒（2400Hz, 8ms, 0.014）
    playWaterNoiseBurst(ctx, graph, startTime, 0.008, 'bandpass', 2400 * j, 2650 * j, 2.6, 0.014);
}

/**
 * ゲームオーバー演出音（静かな水底へ4粒の澄んだ水滴がペンタトニック下降する癒しの終幕音・580ms 同期）
 * 既存呼び出し互換のため関数名 playSoundGameOverZap を維持。
 */
export function playSoundGameOverZap() {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;

    // 濁った三角波を撤廃し、澄んだ4粒の水滴がペンタトニック下降（C5 → A4 → G4 → D4）してリバーブ余韻で静かに消える
    const drops = [
        { delay: 0.000, freq: 523.25, sweep: 0.022, dur: 0.160, peak: 0.19 }, // C5
        { delay: 0.100, freq: 440.00, sweep: 0.024, dur: 0.175, peak: 0.18 }, // A4
        { delay: 0.210, freq: 392.00, sweep: 0.026, dur: 0.190, peak: 0.17 }, // G4
        { delay: 0.330, freq: 293.66, sweep: 0.030, dur: 0.250, peak: 0.16 }  // D4（0.330 + 0.250 = 0.580s 収束）
    ];

    for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        const t0 = now + d.delay;
        const tEnd = t0 + d.dur;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(d.freq * 0.86, t0);
        osc.frequency.exponentialRampToValueAtTime(d.freq, t0 + d.sweep);

        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(d.peak, t0 + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

        osc.connect(gain);
        gain.connect(graph.input);
        bindAutoDisconnect(osc, [osc, gain]);

        osc.start(t0);
        osc.stop(tEnd + 0.02);
    }
}