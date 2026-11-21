/**
 * sound.js
 * @version v8.5 (Suspended Playback Guard, Grace Recovery Fix & Size-Harmonized Chain Pitch - Phase 2)
 * @changes
 *   - getPlayableAudio() で audioCtx.state !== 'running'（suspended / interrupted 等）の場合は必ず null を返すよう修正し、停止中コンテキストへの発音ノード蓄積・リークおよび復帰時爆音を遮断
 *   - getPlayableAudio() の suspended / interrupted 検知へコンテキスト生成直後 300ms のグレース期間ガードを追加し、復帰後 touchstart → touchend 間の誤リカバリ再点灯による再破棄ループ・発射音ブツ切りを根治
 *   - playSoundMerge() の連鎖基準周波数を現在合体サイズ基準周波数（70%）と前連鎖基準（30%）の調和ブレンドへ更新し、大塊と小塊が別箇所で連続合体した際の音程違和感を解消
 * 
 * Web Audio APIを使用した軽量プロシージャル癒し水音サウンドモジュール
 * 
 * 外部の音声ファイルに依存せず、短い水滴ピッチスイープ・純正協和の純サイン波余韻・
 * プロシージャル水辺リバーブを用いて、本家sobosubaのような静かで耳に心地よい水滴・水琴窟ASMRサウンドを
 * 動的に生成・再生します。起動時はデフォルト OFF であり、音量 ON 操作時のハード初期化および
 * 他画面復帰時の自動ハードリカバリに対応します。
 */

let audioCtx = null;

// 現在の audioCtx に 1対1 で紐づくマスターグラフ・共有ノイズバッファ（復帰再生成時に自動破棄・再構築）
let graphCtx = null;
let masterInput = null;
let masterCompressor = null;
let masterGain = null;
let sharedNoiseBuffer = null;

// 高速復帰（< 0.2ms）用のリバーブ IR 生データキャッシュ（サンプルレート単位で再利用）
let cachedReverbSampleRate = 0;
let cachedReverbIRLeft = null;
let cachedReverbIRRight = null;

// デフォルト OFF の音量状態フラグ（起動時は完全無音）
let soundEnabled = false;
let suspendTimer = null;

// 他画面復帰・ゾンビ AudioContext 自動復旧状態管理
let needsAudioRecovery = false;
let pendingTouchendUnlock = false;
let lastRecoveryTimeMs = 0;
let audioCtxCreatedAtMs = 0;
let lastClockWallMs = 0;
let lastClockAudioTime = -1;

// 各種スロットリング・連鎖和声・同時合体アルペジオ状態管理
let lastCollideSoundTime = 0;
let lastAnticipateSoundTime = 0;
let lastSelectSoundTime = 0;
let lastMergeScheduledTime = 0;
let chainBaseFreq = 400;

const COLLIDE_THROTTLE_MS = 55;
const ANTICIPATE_THROTTLE_MS = 35;
const SELECT_THROTTLE_MS = 40;
const RECOVERY_COOLDOWN_MS = 250;
const MASTER_GAIN_LEVEL = 0.92;

// 1〜7連は純正ペンタトニック上昇、8連以降は温かい水琴窟和音帯を波のように優しく往復
const PENTATONIC_RISE_SEMITONES = [0, 2, 4, 7, 9, 12, 14];
const PENTATONIC_WAVE_SEMITONES = [12, 9, 7, 9, 12, 14];

// 復帰・キャプチャリスナーの多重登録防止フラグ
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
 * @param {number} [rate=0.015]
 * @returns {number}
 */
function pitchJitter(rate = 0.015) {
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
 * イベント発生元が音量トグルボタン（#soundToggleBtn）かどうかを判定する
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isSoundToggleTarget(target) {
    return Boolean(
        target &&
        typeof target.closest === 'function' &&
        target.closest('#soundToggleBtn')
    );
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
 * 静かな水辺リバーブ用のステレオ 0.58 秒 指数減衰インパルス応答（IR）バッファを生成する
 * 生データ（Float32Array）をサンプルレート単位でキャッシュし、再構築時のタップ遅延を < 0.2ms へ抑える
 * @param {AudioContext} ctx
 * @returns {AudioBuffer|null}
 */
function createWaterReverbIR(ctx) {
    try {
        const sampleRate = ctx.sampleRate || 44100;
        const duration = 0.58;
        const length = Math.max(2048, Math.floor(sampleRate * duration));

        if (cachedReverbSampleRate !== sampleRate ||
            !cachedReverbIRLeft ||
            !cachedReverbIRRight ||
            cachedReverbIRLeft.length !== length) {
            const left = new Float32Array(length);
            const right = new Float32Array(length);
            const channels = [left, right];

            // わずかな初期プリディレイ（約 8ms）後に滑らかに立ち上がり指数減衰させる
            const preDelaySamples = Math.floor(sampleRate * 0.008);
            const fadeInSamples = Math.floor(sampleRate * 0.018);

            for (let ch = 0; ch < 2; ch++) {
                const data = channels[ch];
                let prev = 0;

                for (let i = 0; i < length; i++) {
                    if (i < preDelaySamples) {
                        data[i] = 0;
                        continue;
                    }
                    const t = (i - preDelaySamples) / Math.max(1, length - preDelaySamples);
                    const fadeIn = Math.min(1, (i - preDelaySamples) / Math.max(1, fadeInSamples));
                    const decay = Math.pow(1 - t, 3.2) * Math.exp(-t * 2.5);
                    // 1次平滑化でざらつきのないシルク状の残響を生成
                    const raw = (Math.random() * 2 - 1);
                    prev = prev * 0.50 + raw * 0.50;
                    data[i] = prev * decay * fadeIn;
                }
            }

            cachedReverbSampleRate = sampleRate;
            cachedReverbIRLeft = left;
            cachedReverbIRRight = right;
        }

        const irBuffer = ctx.createBuffer(2, length, sampleRate);
        if (typeof irBuffer.copyToChannel === 'function') {
            irBuffer.copyToChannel(cachedReverbIRLeft, 0);
            irBuffer.copyToChannel(cachedReverbIRRight, 1);
        } else {
            irBuffer.getChannelData(0).set(cachedReverbIRLeft);
            irBuffer.getChannelData(1).set(cachedReverbIRRight);
        }
        return irBuffer;
    } catch (_err) {
        return null;
    }
}

/**
 * 現在の AudioContext に紐づくマスターチェイン
 * （合流入力 → Dry 80% ＋ Wet 22% 水辺リバーブ [0.58s IR → Lowpass 1650Hz] → Master Lowpass 2600Hz → 高速ソフトリミッター → MasterGain）
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

        // 1. マスターローパスフィルタ（2600Hz, Q=0.45：耳に刺さる金属域を完全遮断し丸く優しい響きへ）
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(2600, now);
        lp.Q.setValueAtTime(0.45, now);

        // 2. パラレル Dry（80%）＋ Wet（22%：静かな水辺リバーブ → 1650Hz ローパス）
        const dryGain = ctx.createGain();
        dryGain.gain.setValueAtTime(0.80, now);
        inputBus.connect(dryGain);
        dryGain.connect(lp);

        if (typeof ctx.createConvolver === 'function') {
            const irBuffer = createWaterReverbIR(ctx);
            if (irBuffer) {
                const convolver = ctx.createConvolver();
                convolver.buffer = irBuffer;

                const wetFilter = ctx.createBiquadFilter();
                wetFilter.type = 'lowpass';
                wetFilter.frequency.setValueAtTime(1650, now);
                wetFilter.Q.setValueAtTime(0.5, now);

                const wetGain = ctx.createGain();
                wetGain.gain.setValueAtTime(0.22, now);

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
 * 共有ホワイトノイズバッファから柔らかな清流スウィッシュを再生する共通ヘルパー
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
 * 音量 ON 時の温かく澄んだ2粒の水琴窟雫確認音（ハード初期化直後の発音確認を兼ねる）
 * @param {AudioContext} ctx
 */
function playConfirmOnTone(ctx) {
    if (!ctx || ctx.state === 'closed') return;
    const graph = ensureAudioGraph(ctx);
    if (!graph) return;

    try {
        const now = ctx.currentTime;
        const drops = [
            { delay: 0,     fStart: 392, fEnd: 494, sweep: 0.026, dur: 0.145, peak: 0.12 },
            { delay: 0.056, fStart: 494, fEnd: 587, sweep: 0.028, dur: 0.175, peak: 0.11 }
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
            gain.gain.linearRampToValueAtTime(d.peak, t0 + 0.008);
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
 * タブ・別画面・別アプリへの離脱監視と、復帰後初回操作時の
 * 2段構えキャプチャ先行ハードリカバリ（touchstart/mousedown → touchend/click）を1度だけ登録する
 */
function bindAudioLifecycleListeners() {
    if (lifecycleListenersBound || typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }
    lifecycleListenersBound = true;

    // 離脱検知：音量 ON のまま別画面へ移った場合は、復帰後初回操作で自動ハード再構築するようフラグを立てる
    const markNeedsRecovery = () => {
        if (!soundEnabled) return;
        needsAudioRecovery = true;
    };

    const tryAutoResume = () => {
        if (!soundEnabled || !audioCtx || audioCtx.state === 'closed') return;
        if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
            try {
                const res = audioCtx.resume();
                if (res && typeof res.catch === 'function') {
                    res.catch(() => {});
                }
            } catch (_err) {
                // 自動再開が拒否された場合は復帰後初回操作のキャプチャ先行ハードリカバリで確実に復旧
            }
        }
    };

    // 経路 1〜3：バックグラウンド離脱・画面遷移・GRAVITYネイティブオーバーレイ遷移の検知
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            markNeedsRecovery();
        } else if (document.visibilityState === 'visible') {
            tryAutoResume();
        }
    });
    window.addEventListener('pagehide', markNeedsRecovery);
    window.addEventListener('blur', markNeedsRecovery);
    window.addEventListener('pageshow', (e) => {
        if (e && e.persisted) {
            markNeedsRecovery();
        }
        tryAutoResume();
    });
    window.addEventListener('focus', tryAutoResume);

    // 復帰後 1 段目（touchstart / mousedown キャプチャ先行）：input.js / aim.js より先に同期ハード再構築
    const handleStartCaptureRecovery = (e) => {
        if (!soundEnabled || !needsAudioRecovery) return;
        // 音量ボタン押下（OFF 切替等）とは競合させない
        if (e && isSoundToggleTarget(e.target)) return;

        const nowMs = performance.now();
        if (nowMs - lastRecoveryTimeMs < RECOVERY_COOLDOWN_MS) return;

        lastRecoveryTimeMs = nowMs;
        needsAudioRecovery = false;
        // 厳格な iOS WebKit で touchstart 起動が保留された場合に備え、直後の touchend / click でダメ押し解除を予約
        pendingTouchendUnlock = true;
        hardResetAudioContext(false);
    };

    // 復帰後 2 段目（touchend / click キャプチャ先行）：iOS が確実に User Activation を認める瞬間にダメ押しアンロック
    const handleEndCaptureUnlock = (e) => {
        if (!soundEnabled) return;
        if (!pendingTouchendUnlock && !needsAudioRecovery) return;
        if (e && isSoundToggleTarget(e.target)) return;

        const wasNeedsRecovery = needsAudioRecovery;
        pendingTouchendUnlock = false;
        needsAudioRecovery = false;

        if (!audioCtx || audioCtx.state === 'closed' || audioCtx.state === 'interrupted') {
            lastRecoveryTimeMs = performance.now();
            hardResetAudioContext(false);
            return;
        }

        if (wasNeedsRecovery) {
            const nowMs = performance.now();
            if (nowMs - lastRecoveryTimeMs >= RECOVERY_COOLDOWN_MS) {
                lastRecoveryTimeMs = nowMs;
                hardResetAudioContext(false);
                return;
            }
        }

        // touchstart で作成済みの audioCtx を壊さずに resume() ＋ 無音バッファで確実に起動完了させる
        try {
            if (audioCtx.state !== 'running') {
                const res = audioCtx.resume();
                if (res && typeof res.catch === 'function') {
                    res.catch(() => {});
                }
            }
            playSilentUnlockBuffer(audioCtx);
            ensureAudioGraph(audioCtx);
        } catch (_err) {
            hardResetAudioContext(false);
        }
    };

    window.addEventListener('touchstart', handleStartCaptureRecovery, { capture: true, passive: true });
    window.addEventListener('mousedown', handleStartCaptureRecovery, { capture: true, passive: true });
    window.addEventListener('touchend', handleEndCaptureUnlock, { capture: true, passive: true });
    window.addEventListener('click', handleEndCaptureUnlock, { capture: true, passive: true });
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
 * 3. 経路 4（onstatechange 中断監視）をバインドし、オプションで音量 ON 水滴確認音を鳴らす
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

    if (oldCtx) {
        try {
            oldCtx.onstatechange = null;
        } catch (_err) {
            // 無視
        }
        if (oldCtx.state !== 'closed') {
            try {
                const closePromise = oldCtx.close();
                if (closePromise && typeof closePromise.catch === 'function') {
                    closePromise.catch(() => {});
                }
            } catch (_err) {
                // 既にクローズ済み等の例外は無視
            }
        }
    }

    // 2. 同一同期スタック内で新規 AudioContext とマスターグラフを構築し、即座に resume() ＋ 無音バッファ再生でアンロック
    try {
        const nextCtx = new AudioContextClass();
        audioCtx = nextCtx;
        audioCtxCreatedAtMs = performance.now();
        lastClockWallMs = 0;
        lastClockAudioTime = -1;
        lastCollideSoundTime = 0;
        lastAnticipateSoundTime = 0;
        lastSelectSoundTime = 0;
        lastMergeScheduledTime = 0;
        chainBaseFreq = 400;

        // 経路 4：音量 ON 稼働中に OS から interrupted / suspended された瞬間を検知して次回操作で確実復旧
        nextCtx.onstatechange = () => {
            if (audioCtx !== nextCtx || !soundEnabled) return;
            if (nextCtx.state === 'interrupted' || nextCtx.state === 'suspended') {
                needsAudioRecovery = true;
            }
        };

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

    if (needsAudioRecovery || !audioCtx || audioCtx.state === 'closed') {
        needsAudioRecovery = false;
        pendingTouchendUnlock = true;
        lastRecoveryTimeMs = performance.now();
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
    needsAudioRecovery = false;
    pendingTouchendUnlock = false;

    if (suspendTimer) {
        clearTimeout(suspendTimer);
        suspendTimer = null;
    }

    if (nextEnabled) {
        lastRecoveryTimeMs = performance.now();
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
 * 全効果音共通の再生可否ガード（ミュート・未初期化・中断状態の安全制御 ＆ 経路5 currentTime フリーズ監視 ＆ マスターグラフ確保）
 * ※非ユーザージェスチャー内での誤リセットを避けるため、フリーズ検知時は needsAudioRecovery フラグを立てるのみとし、次回ユーザー操作で安全に再構築する
 * @returns {{ ctx: AudioContext, graph: { input: AudioNode, masterGain: GainNode, noiseBuffer: AudioBuffer|null } } | null}
 */
function getPlayableAudio() {
    if (!soundEnabled || !audioCtx || audioCtx.state === 'closed') return null;

    const nowWallMs = performance.now();

    if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
        // コンテキスト生成直後 300ms グレース期間内の非同期 resume() 待ちでは誤リカバリを再点灯しない
        if (nowWallMs - audioCtxCreatedAtMs >= 300) {
            needsAudioRecovery = true;
        }
        try {
            const res = audioCtx.resume();
            if (res && typeof res.catch === 'function') {
                res.catch(() => {});
            }
        } catch (_err) {
            // 無視
        }
        // 停止中コンテキストへの発音ノード蓄積・リーク・復帰時爆音を完全遮断
        return null;
    }

    if (audioCtx.state !== 'running') return null;

    // 経路 5：ゾンビ AudioContext（state === 'running' なのに currentTime が停止）の検知
    // コンテキスト生成直後 300ms はグレース期間として除外
    if (nowWallMs - audioCtxCreatedAtMs >= 300) {
        const curAudioTime = audioCtx.currentTime;
        if (lastClockWallMs > 0) {
            if ((nowWallMs - lastClockWallMs) >= 180) {
                if ((curAudioTime - lastClockAudioTime) < 0.001) {
                    needsAudioRecovery = true;
                }
                lastClockWallMs = nowWallMs;
                lastClockAudioTime = curAudioTime;
            }
        } else {
            lastClockWallMs = nowWallMs;
            lastClockAudioTime = curAudioTime;
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
    const j = pitchJitter(0.012);

    // 水面に指先がそっと触れたような極小雫音（430〜300Hz → +14%、24ms上昇、52ms余韻）
    const startFreq = (430 - sizeNorm * 130) * j;
    const endFreq = startFreq * 1.14;
    const sweepDur = 0.024;
    const totalDur = 0.052;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + sweepDur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.05, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + totalDur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + totalDur + 0.02);
}

/**
 * 発射音（そっと落とし「ぽとん」〜 下方向強ショット「さらっ」）
 * @param {number} [powerRatio=0.5] - 発射強度比率（0.0 = そっと落とし 〜 1.0 = 全力下ショット）
 */
export function playSoundShoot(powerRatio = 0.5) {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const p = clamp(Number(powerRatio), 0, 1);
    const safePower = Number.isFinite(p) ? p : 0.5;
    const j = pitchJitter(0.012);

    // そっと落とし: 290→370Hz (26ms上昇, 80ms余韻, 0.085)、強ショット: 310→460Hz (34ms上昇, 0.13)
    const startFreq = (290 + safePower * 20) * j;
    const endFreq = (370 + safePower * 90) * j;
    const sweepDur = 0.026 + safePower * 0.008;
    const totalDur = 0.080 + safePower * 0.018;
    const peakGain = 0.085 + safePower * 0.045;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + sweepDur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.007);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + totalDur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + totalDur + 0.02);

    // 強ショット時のみ控えめで丸い清流スウィッシュ（950→1750Hz, 28ms, 最大 0.018）を薄く付加
    const swishGain = safePower * 0.018;
    if (swishGain > 0.002) {
        playWaterNoiseBurst(
            ctx,
            graph,
            now,
            0.028,
            'bandpass',
            950 * j,
            1750 * j,
            2.2,
            swishGain
        );
    }
}

/**
 * 上段飛び越えホップ音（Bar-Hop：2粒の温かく澄んだ水滴が軽やかに跳ねる音「ぽろりん」）
 */
export function playSoundHop() {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const j = pitchJitter(0.012);

    const drops = [
        { delay: 0.000, fStart: 350, fEnd: 440, sweep: 0.024, dur: 0.092, peak: 0.110 },
        { delay: 0.032, fStart: 440, fEnd: 587, sweep: 0.028, dur: 0.120, peak: 0.115 }
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
        gain.gain.linearRampToValueAtTime(d.peak, t0 + 0.007);
        gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

        osc.connect(gain);
        gain.connect(graph.input);
        bindAutoDisconnect(osc, [osc, gain]);

        osc.start(t0);
        osc.stop(tEnd + 0.02);
    }
}

/**
 * 接触音（異数字衝突・高速壁/床着地時の静かで耳に優しい水滴音「ぽちゃ」「ころん」「こぽっ」）
 * 連続落下時にも邪魔にならない 440〜230Hz 帯域・7ms 丸アタック・55ms 間引き・ノイズなし純水滴構成
 * @param {number} [intensity=0.5] - 衝突の強さ（0.0 〜 1.0）
 * @param {number} [jellyValue=4] - 衝突したゼリーの数値（小さいほど高音、大きいほど低音）
 */
export function playSoundCollide(intensity = 0.5, jellyValue = 4) {
    const audio = getPlayableAudio();
    if (!audio || intensity < 0.1) return;

    // 55ms 以内の連続発火を制限し、連続落下や大合体衝撃波時の同時衝突スパイクを防止
    const nowMs = performance.now();
    if (nowMs - lastCollideSoundTime < COLLIDE_THROTTLE_MS) return;
    lastCollideSoundTime = nowMs;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;
    const clampedIntensity = clamp(Number(intensity) || 0.5, 0.1, 1.0);
    const sizeNorm = getAnySizeNorm(jellyValue); // 0.0(最小) 〜 1.0(最大)
    const j = pitchJitter(0.015);

    // サイズ帯域 440Hz（小）〜 230Hz（大）：0.86f → 1.12f へ 20〜28ms 穏やかに上がり、62〜92ms で静かに消える
    const baseFreq = (440 - sizeNorm * 210) * j;
    const sweepDur = 0.020 + sizeNorm * 0.008;
    const totalDur = 0.062 + sizeNorm * 0.030;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * 0.86, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.12, now + sweepDur);

    const peakGain = 0.045 + clampedIntensity * 0.075; // 0.045 〜 0.12 の耳に優しい控えめバランス
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.007);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + totalDur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + totalDur + 0.02);
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
    const j = pitchJitter(0.010);

    // 400〜230Hz 帯域で 1.06f → 0.92f へ 30ms そっと吸い込む極小の純サイン波（ノイズなし）
    const baseFreq = (400 - sizeNorm * 170) * j;
    const dur = 0.030;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * 1.06, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(150, baseFreq * 0.92), now + dur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.045, now + 0.007);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain);
    gain.connect(graph.input);
    bindAutoDisconnect(osc, [osc, gain]);

    osc.start(now);
    osc.stop(now + dur + 0.02);
}

/**
 * 合体音（耳に優しいせせらぎ・水琴窟ASMR合成「ぽろんっ…ぴく」／大塊「こぽぉんっ…ぽろ」）
 * 400〜220Hz 黄金帯域・ウェーブペンタトニック旋律・3層純正整数比（完全オクターブ/完全五度）・
 * 等ラウドネス自動補正・連続密度ダッキング・62ms ハープアルペジオ・ノイズ撤廃・10ms 丸アタック
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
    // 連続合体の残響がリバーブ内で澄んだペンタトニック和音として溶け合うよう揺らぎを ±0.4% に制限
    const j = pitchJitter(0.004);

    // 同時複数合体時は 62ms ずつ微シフト（最大遅延 186ms）して粒立ちのよいハープ・アルペジオにする
    const prevScheduled = lastMergeScheduledTime;
    let startTime = now;
    if (prevScheduled > now - 0.060) {
        startTime = Math.min(now + 0.186, prevScheduled + 0.062);
    }
    lastMergeScheduledTime = startTime;

    // 連続落下・同時合体時の自動ソフトダッキング（間隔 < 260ms ほど柔らかく音量を抑える）
    const deltaSincePrev = (prevScheduled > 0) ? Math.max(0, startTime - prevScheduled) : 1.0;
    const densityRatio = clamp(deltaSincePrev / 0.260, 0, 1);
    const mainDuck = 0.76 + 0.24 * densityRatio; // 0.76 〜 1.00
    const subDuck = 0.50 + 0.50 * densityRatio;  // 0.50 〜 1.00

    // 連鎖開始（chainCount === 0）でサイズ基準周波数（400〜220Hz）を記憶し、
    // 連鎖中は現在合体サイズ（70%）と前連鎖基準（30%）を調和ブレンドして大塊⇔小塊の飛び連鎖でもサイズ感を維持
    // 1〜7連は純正ペンタトニック上昇、8連以降は最高音張り付きを防いで温かい和音帯を波のように往復
    const sizeBaseFreq = 400 - sizeNorm * 180;
    if (safeChain === 0) {
        chainBaseFreq = sizeBaseFreq;
    } else {
        chainBaseFreq = sizeBaseFreq * 0.70 + chainBaseFreq * 0.30;
    }

    const semitones = (safeChain < PENTATONIC_RISE_SEMITONES.length)
        ? PENTATONIC_RISE_SEMITONES[safeChain]
        : PENTATONIC_WAVE_SEMITONES[(safeChain - PENTATONIC_RISE_SEMITONES.length) % PENTATONIC_WAVE_SEMITONES.length];
    const pitchRatio = Math.pow(2, semitones / 12);
    const f = chainBaseFreq * pitchRatio * j;

    // --- 層 1：主水滴（純サイン波：24〜38ms で 0.82f → 1.18f へ穏やかに上昇、10ms 丸アタック、等ラウドネス補正） ---
    const sweepDur = 0.024 + sizeNorm * 0.014;
    const decayDur = 0.180 + sizeNorm * 0.120;
    const mainStartFreq = Math.max(150, f * 0.82);
    const mainEndFreq = Math.min(1180, f * 1.18);
    const loudnessComp = clamp(Math.pow(420 / Math.max(420, mainEndFreq), 0.55), 0.56, 1.0);
    const mainPeak = (0.255 + sizeNorm * 0.035) * loudnessComp * mainDuck;

    const mainOsc = ctx.createOscillator();
    const mainGain = ctx.createGain();
    mainOsc.type = 'sine';
    mainOsc.frequency.setValueAtTime(mainStartFreq, startTime);
    mainOsc.frequency.exponentialRampToValueAtTime(mainEndFreq, startTime + sweepDur);

    mainGain.gain.setValueAtTime(0.0001, startTime);
    mainGain.gain.linearRampToValueAtTime(mainPeak, startTime + 0.010);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + decayDur);

    mainOsc.connect(mainGain);
    mainGain.connect(graph.input);
    bindAutoDisconnect(mainOsc, [mainOsc, mainGain]);

    mainOsc.start(startTime);
    mainOsc.stop(startTime + decayDur + 0.02);

    // --- 層 2：水底ボディ（純正整数比：mainEndFreq >= 310Hz は完全オクターブ 1:2、未満は純正完全五度下 2:3 で濁りゼロ） ---
    const bodyFreq = (mainEndFreq >= 310) ? (mainEndFreq * 0.5) : (mainEndFreq * (2 / 3));
    const bodyDur = 0.165 + sizeNorm * 0.115;
    const bodyPeak = (0.030 + sizeNorm * 0.065) * loudnessComp * mainDuck;

    const bodyOsc = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    bodyOsc.type = 'sine';
    bodyOsc.frequency.setValueAtTime(bodyFreq * 0.92, startTime);
    bodyOsc.frequency.exponentialRampToValueAtTime(bodyFreq, startTime + sweepDur * 0.95);

    bodyGain.gain.setValueAtTime(0.0001, startTime);
    bodyGain.gain.linearRampToValueAtTime(bodyPeak, startTime + 0.012);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, startTime + bodyDur);

    bodyOsc.connect(bodyGain);
    bodyGain.connect(graph.input);
    bindAutoDisconnect(bodyOsc, [bodyOsc, bodyGain]);

    bodyOsc.start(startTime);
    bodyOsc.stop(startTime + bodyDur + 0.02);

    // --- 層 3：2次小雫（40〜58ms 遅れ：主音到達の純正完全五度上 1.5倍・連続密度ダッキング連動・高域ノイズなし） ---
    const subDelay = 0.040 + sizeNorm * 0.018;
    const subStart = startTime + subDelay;
    const subSweep = 0.018;
    const subDur = 0.068 + sizeNorm * 0.026;
    const subEndFreq = Math.min(1650, mainEndFreq * 1.5);
    const subStartFreq = subEndFreq * 0.84;
    const subPeak = mainPeak * 0.18 * subDuck;

    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(subStartFreq, subStart);
    subOsc.frequency.exponentialRampToValueAtTime(subEndFreq, subStart + subSweep);

    subGain.gain.setValueAtTime(0.0001, subStart);
    subGain.gain.linearRampToValueAtTime(subPeak, subStart + 0.006);
    subGain.gain.exponentialRampToValueAtTime(0.0001, subStart + subDur);

    subOsc.connect(subGain);
    subGain.connect(graph.input);
    bindAutoDisconnect(subOsc, [subOsc, subGain]);

    subOsc.start(subStart);
    subOsc.stop(subStart + subDur + 0.02);
}

/**
 * ゲームオーバー演出音（静かな水底へ4粒の温かい水滴がペンタトニック下降する癒しの終幕音・580ms 同期）
 * 既存呼び出し互換のため関数名 playSoundGameOverZap を維持。
 */
export function playSoundGameOverZap() {
    const audio = getPlayableAudio();
    if (!audio) return;

    const { ctx, graph } = audio;
    const now = ctx.currentTime;

    // 温かい4粒の水滴がペンタトニック下降（A4 → G4 → E4 → C4）してリバーブ余韻で静かに消える
    const drops = [
        { delay: 0.000, freq: 440.00, sweep: 0.024, dur: 0.165, peak: 0.16 }, // A4
        { delay: 0.100, freq: 392.00, sweep: 0.026, dur: 0.180, peak: 0.15 }, // G4
        { delay: 0.210, freq: 329.63, sweep: 0.028, dur: 0.195, peak: 0.14 }, // E4
        { delay: 0.330, freq: 261.63, sweep: 0.032, dur: 0.250, peak: 0.13 }  // C4（0.330 + 0.250 = 0.580s 収束）
    ];

    for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        const t0 = now + d.delay;
        const tEnd = t0 + d.dur;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(d.freq * 0.88, t0);
        osc.frequency.exponentialRampToValueAtTime(d.freq, t0 + d.sweep);

        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(d.peak, t0 + 0.009);
        gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

        osc.connect(gain);
        gain.connect(graph.input);
        bindAutoDisconnect(osc, [osc, gain]);

        osc.start(t0);
        osc.stop(tEnd + 0.02);
    }
}