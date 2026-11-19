/**
 * sound.js
 * @version v6.0 (Fluid Physics, Controls, Bumper & Audio Overhaul Step 2)
 * @changes
 *   - デフォルト OFF の音量状態管理（isSoundEnabled / setSoundEnabled / toggleSound）と、全効果音（Shoot / Hop / Collide / Merge / GameOverZap）へのミュートガードを追加
 *   - 他画面・別アプリ切替後の無音化を確実に復旧するため、iOS WebView のユーザージェスチャー同期制約に準拠したハード初期化 hardResetAudioContext()（旧 AudioContext の非同期クローズ退避＋同一同期スタックでの新規生成・resume()・1サンプル無音バッファアンロック＋オン確認音）を実装
 *   - visibilitychange / pageshow / focus イベントによる自動復帰と iOS 特有の 'interrupted' 状態への対応、および ON 時自動リカバリ ensureAudioRunning() を追加
 * 
 * Web Audio APIを使用した軽量サウンドモジュール
 * 
 * 外部の音声ファイルに依存せず、オシレーター（波形合成）を用いて
 * 「発射音」「ホップ音」「サイズ連動接触音」「合体音（連鎖ピッチ上昇対応）」「ゲームオーバーザップ音」を
 * 動的に生成・再生します。起動時はデフォルト OFF であり、音量 ON 操作時にハード初期化を行います。
 */

let audioCtx = null;

// デフォルト OFF の音量状態フラグ（起動時は完全無音）
let soundEnabled = false;

// 衝突音の多重発火・音割れを防ぐためのスロットリング管理（60ms）
let lastCollideSoundTime = 0;
const COLLIDE_THROTTLE_MS = 60;

// 復帰リスナーの多重登録防止フラグ
let lifecycleListenersBound = false;

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
        source.start(0);
    } catch (_err) {
        // 再生不可環境でもゲーム進行を止めない
    }
}

/**
 * 音量 ON 時の軽快な確認音（ハード初期化直後の発音確認を兼ねる）
 * @param {AudioContext} ctx
 */
function playConfirmOnTone(ctx) {
    if (!ctx || ctx.state === 'closed') return;
    try {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        const now = ctx.currentTime;

        osc.type = 'sine';
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);

        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(780, now + 0.08);

        gainNode.gain.setValueAtTime(0.001, now);
        gainNode.gain.linearRampToValueAtTime(0.16, now + 0.012);
        gainNode.gain.exponentialRampToValueAtTime(0.005, now + 0.09);

        osc.start(now);
        osc.stop(now + 0.09);
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
 * 1. 旧 AudioContext をローカル変数へ退避して非同期クローズ（await せずユーザージェスチャー同期スタックを維持）
 * 2. 同一同期スタック内で新規 AudioContext を生成し、resume() ＋ 1サンプル無音バッファでハードアンロック
 * 3. オプションで音量 ON 確認音を鳴らす
 * @param {boolean} [playConfirm=true] - 初期化直後にオン確認音を鳴らすかどうか
 * @returns {boolean} 新規 AudioContext の構築に成功した場合は true
 */
export function hardResetAudioContext(playConfirm = true) {
    const AudioContextClass = (typeof window !== 'undefined')
        ? (window.AudioContext || window.webkitAudioContext)
        : null;
    if (!AudioContextClass) return false;

    // 1. 旧コンテキストをローカル変数へ退避し、await せずにバックグラウンドでクローズ
    const oldCtx = audioCtx;
    audioCtx = null;
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

    // 2. 同一同期スタック内で新規 AudioContext を構築し、即座に resume() ＋ 無音バッファ再生でアンロック
    try {
        const nextCtx = new AudioContextClass();
        audioCtx = nextCtx;
        lastCollideSoundTime = 0;

        if (nextCtx.state === 'suspended' || nextCtx.state === 'interrupted') {
            const resumePromise = nextCtx.resume();
            if (resumePromise && typeof resumePromise.catch === 'function') {
                resumePromise.catch(() => {});
            }
        }

        playSilentUnlockBuffer(nextCtx);

        // 3. オン確認音でハード出力の再開をユーザーへ明確にフィードバック
        if (playConfirm) {
            playConfirmOnTone(nextCtx);
        }
        return true;
    } catch (_err) {
        audioCtx = null;
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
}

/**
 * 音量の ON / OFF を設定する
 * ON 切替時は必ず同期ハード初期化（hardResetAudioContext）を実行して別画面復帰後の無音化を確実に解消する
 * @param {boolean} enabled - true で ON、false で OFF
 * @returns {boolean} 更新後の音量状態
 */
export function setSoundEnabled(enabled) {
    const nextEnabled = Boolean(enabled);
    soundEnabled = nextEnabled;

    if (nextEnabled) {
        hardResetAudioContext(true);
    } else if (audioCtx && audioCtx.state === 'running') {
        try {
            const suspendPromise = audioCtx.suspend();
            if (suspendPromise && typeof suspendPromise.catch === 'function') {
                suspendPromise.catch(() => {});
            }
        } catch (_err) {
            // 無視
        }
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
 * 全効果音共通の再生可否ガード（ミュート・未初期化・中断状態の安全制御）
 * @returns {AudioContext|null} 再生可能な AudioContext、再生不可時は null
 */
function getPlayableContext() {
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
    return audioCtx;
}

/**
 * 発射音（通常ショット／そっと落とし）
 * 軽く弾くような短い音（周波数が瞬間的に上がる）
 */
export function playSoundShoot() {
    const ctx = getPlayableContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = 'triangle';
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    const now = ctx.currentTime;

    // ピッチ（周波数）を急激に上げて「シュッ」と飛ばす質感を出す
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.1);

    // 音量（エンベロープ）の制御（全体バランス最適化）
    gainNode.gain.setValueAtTime(0.24, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    osc.start(now);
    osc.stop(now + 0.1);
}

/**
 * 上段飛び越えホップ音（Bar-Hop）
 * 上向きドラッグで他の塊を飛び越える際の軽快な「ポィン」という音
 */
export function playSoundHop() {
    const ctx = getPlayableContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = 'sine';
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    const now = ctx.currentTime;

    // 柔らかく弾み上がるピッチカーブで「飛び越え感」を演出
    osc.frequency.setValueAtTime(250, now);
    osc.frequency.exponentialRampToValueAtTime(560, now + 0.09);
    osc.frequency.exponentialRampToValueAtTime(490, now + 0.14);

    // 耳障りにならない軽快な音量エンベロープ
    gainNode.gain.setValueAtTime(0.001, now);
    gainNode.gain.linearRampToValueAtTime(0.22, now + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.008, now + 0.14);

    osc.start(now);
    osc.stop(now + 0.14);
}

/**
 * 接触音（ぷるんとした物体同士のぶつかり）
 * 60msスロットリングおよびゼリーサイズ連動ピッチ変化に対応
 * @param {number} intensity - 衝突の強さ（0.0 〜 1.0）。弱い衝突では音を鳴らさない制御などに使います。
 * @param {number} jellyValue - 衝突したゼリーの数値（小さいほど高音、大きいほど低音）
 */
export function playSoundCollide(intensity = 0.5, jellyValue = 4) {
    // ミュート・コンテキスト未準備・衝撃が弱すぎる（0.1未満）場合はスキップして処理を軽くする
    const ctx = getPlayableContext();
    if (!ctx || intensity < 0.1) return;

    // 60ms以内の連続発火を制限し、中空ビーズ複数同時接触による音割れを防止
    const nowMs = performance.now();
    if (nowMs - lastCollideSoundTime < COLLIDE_THROTTLE_MS) return;
    lastCollideSoundTime = nowMs;

    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = 'sine'; // 柔らかいぷるぷる感にするためサイン波を使用
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    const now = ctx.currentTime;
    const clampedIntensity = Math.max(0.1, Math.min(1.0, Number(intensity) || 0.5));

    // ゼリーの大きさ（2の累乗ランク：0〜14）に応じて基準ピッチを滑らかに変化
    // 小さいゼリー(1, 2)は軽やかな高め(約260Hz)、大きいゼリー(1024〜16384)は落ち着いた低め(約95Hz)
    const safeVal = Math.max(1, Number(jellyValue) || 4);
    const tier = Math.min(14, Math.max(0, Math.log2(safeVal)));
    const sizeRatio = 1 - (tier / 14); // 1.0(最小) 〜 0.0(最大)
    const baseFreq = 95 + (sizeRatio * 165);

    // 衝突の強さをわずかに上乗せして自然な抑揚をつける
    const startFreq = baseFreq + (clampedIntensity * 45);
    const endFreq = Math.max(55, baseFreq * 0.68);

    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.09);

    // 全体バランスに合わせ、強さに比例しつつ最大0.28に抑制
    const maxGain = Math.min(0.28, clampedIntensity * 0.34);
    gainNode.gain.setValueAtTime(maxGain, now);
    gainNode.gain.exponentialRampToValueAtTime(0.008, now + 0.09);

    osc.start(now);
    osc.stop(now + 0.09);
}

/**
 * 合体音（気持ちいい連鎖音）
 * 連鎖数に応じて半音ずつ音程が上がるポップな音
 * @param {number} chainCount - 現在の連鎖回数（0始まり、最大12半音＝1オクターブ上昇まで）
 */
export function playSoundMerge(chainCount = 0) {
    const ctx = getPlayableContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = 'sine';
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    const now = ctx.currentTime;

    // 連鎖数に応じて半音ずつ（12平均律）ピッチを上昇させる（最大1オクターブ上昇）
    const safeChain = Math.min(12, Math.max(0, Number(chainCount) || 0));
    const pitchRatio = Math.pow(2, safeChain / 12);
    const startFreq = 400 * pitchRatio;
    const endFreq = 800 * pitchRatio;

    // 合体時の心地よい「ポポン」という音（2段階の周波数変化）
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.1);

    // 一瞬で音量を上げ（アタック）、連鎖連続再生でも音割れしないバランスに最適化
    gainNode.gain.setValueAtTime(0.001, now);
    gainNode.gain.linearRampToValueAtTime(0.30, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.008, now + 0.2);

    osc.start(now);
    osc.stop(now + 0.2);
}

/**
 * ゲームオーバー演出音（Game Over Zap）
 * 左右バンパー同時押し込み確定時に鳴る電気的・衝撃的なザップ音
 */
export function playSoundGameOverZap() {
    const ctx = getPlayableContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const duration = 0.42;

    // 1. 電気的な鋭さを出すノコギリ波（高周波から急降下）
    const zapOsc = ctx.createOscillator();
    const zapGain = ctx.createGain();
    zapOsc.type = 'sawtooth';
    zapOsc.frequency.setValueAtTime(920, now);
    zapOsc.frequency.exponentialRampToValueAtTime(210, now + 0.08);
    zapOsc.frequency.exponentialRampToValueAtTime(520, now + 0.14);
    zapOsc.frequency.exponentialRampToValueAtTime(65, now + duration);

    zapGain.gain.setValueAtTime(0.22, now);
    zapGain.gain.exponentialRampToValueAtTime(0.14, now + 0.14);
    zapGain.gain.exponentialRampToValueAtTime(0.005, now + duration);

    zapOsc.connect(zapGain);
    zapGain.connect(ctx.destination);

    // 2. ビリッとした衝撃感を補強する矩形波（短めのパルス変調）
    const buzzOsc = ctx.createOscillator();
    const buzzGain = ctx.createGain();
    buzzOsc.type = 'square';
    buzzOsc.frequency.setValueAtTime(160, now);
    buzzOsc.frequency.exponentialRampToValueAtTime(48, now + 0.26);

    buzzGain.gain.setValueAtTime(0.14, now);
    buzzGain.gain.exponentialRampToValueAtTime(0.005, now + 0.26);

    buzzOsc.connect(buzzGain);
    buzzGain.connect(ctx.destination);

    zapOsc.start(now);
    zapOsc.stop(now + duration);

    buzzOsc.start(now);
    buzzOsc.stop(now + 0.26);
}