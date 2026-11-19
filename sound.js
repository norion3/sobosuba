/**
 * sound.js
 * @version v3.0 (Overhaul Step 2)
 * @changes
 *   - 連鎖数に応じて合体音の音程が半音ずつ心地よく上昇する playSoundMerge(chainCount) へ拡張
 *   - 本家sobosuba特徴の電気的・衝撃的なゲームオーバー演出音 playSoundGameOverZap() を追加
 * 
 * Web Audio APIを使用した軽量サウンドモジュール
 * 
 * 外部の音声ファイルに依存せず、オシレーター（波形合成）を用いて
 * 「発射音」「接触音」「合体音（連鎖ピッチ上昇対応）」「ゲームオーバーザップ音」を
 * 動的に生成・再生します。
 */

let audioCtx = null;

/**
 * オーディオコンテキストの初期化
 * ブラウザの仕様上、初回はユーザーアクション（タップやクリック）のイベント内で呼び出す必要があります。
 */
export function initSound() {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
    }
    // iOS/Safari対策: サスペンド状態なら再開する
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

/**
 * 発射音（スリングショット）
 * 軽く弾くような短い音（周波数が瞬間的に上がる）
 */
export function playSoundShoot() {
    if (!audioCtx) return;
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'triangle';
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    
    // ピッチ（周波数）を急激に上げて「シュッ」と飛ばす質感を出す
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.1);

    // 音量（エンベロープ）の制御
    gainNode.gain.setValueAtTime(0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    osc.start(now);
    osc.stop(now + 0.1);
}

/**
 * 接触音（ぷるんとした物体同士のぶつかり）
 * @param {number} intensity - 衝突の強さ（0.0 〜 1.0）。弱い衝突では音を鳴らさない制御などに使います。
 */
export function playSoundCollide(intensity = 0.5) {
    // コンテキストが無い、または衝撃が弱すぎる（0.1未満）場合はスキップして処理を軽くする
    if (!audioCtx || intensity < 0.1) return;
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'sine'; // 柔らかい音にするためサイン波を使用
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    
    // 衝突の強さによって音の高さ（周波数）を少し変える
    const freq = 150 + (intensity * 100);
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);

    // 音量も強さに比例させる（ただし最大0.4に抑えてうるさくならないようにする）
    const maxGain = Math.min(0.4, intensity * 0.5);
    gainNode.gain.setValueAtTime(maxGain, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    osc.start(now);
    osc.stop(now + 0.1);
}

/**
 * 合体音（気持ちいい連鎖音）
 * 連鎖数に応じて半音ずつ音程が上がるポップな音
 * @param {number} chainCount - 現在の連鎖回数（0始まり、最大12半音＝1オクターブ上昇まで）
 */
export function playSoundMerge(chainCount = 0) {
    if (!audioCtx) return;
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'sine';
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    
    // 連鎖数に応じて半音ずつ（12平均律）ピッチを上昇させる（最大1オクターブ上昇）
    const safeChain = Math.min(12, Math.max(0, Number(chainCount) || 0));
    const pitchRatio = Math.pow(2, safeChain / 12);
    const startFreq = 400 * pitchRatio;
    const endFreq = 800 * pitchRatio;

    // 合体時の心地よい「ポポン」という音（2段階の周波数変化）
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.1);

    // 一瞬で音量を上げ（アタック）、少し余韻を残して消える（リリース）
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.4, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

    osc.start(now);
    osc.stop(now + 0.2);
}

/**
 * ゲームオーバー演出音（Game Over Zap）
 * 左右バンパー同時押し込み確定時に鳴る電気的・衝撃的なザップ音
 */
export function playSoundGameOverZap() {
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const duration = 0.42;

    // 1. 電気的な鋭さを出すノコギリ波（高周波から急降下）
    const zapOsc = audioCtx.createOscillator();
    const zapGain = audioCtx.createGain();
    zapOsc.type = 'sawtooth';
    zapOsc.frequency.setValueAtTime(920, now);
    zapOsc.frequency.exponentialRampToValueAtTime(210, now + 0.08);
    zapOsc.frequency.exponentialRampToValueAtTime(520, now + 0.14);
    zapOsc.frequency.exponentialRampToValueAtTime(65, now + duration);

    zapGain.gain.setValueAtTime(0.28, now);
    zapGain.gain.exponentialRampToValueAtTime(0.18, now + 0.14);
    zapGain.gain.exponentialRampToValueAtTime(0.005, now + duration);

    zapOsc.connect(zapGain);
    zapGain.connect(audioCtx.destination);

    // 2. ビリッとした衝撃感を補強する矩形波（短めのパルス変調）
    const buzzOsc = audioCtx.createOscillator();
    const buzzGain = audioCtx.createGain();
    buzzOsc.type = 'square';
    buzzOsc.frequency.setValueAtTime(160, now);
    buzzOsc.frequency.exponentialRampToValueAtTime(48, now + 0.26);

    buzzGain.gain.setValueAtTime(0.2, now);
    buzzGain.gain.exponentialRampToValueAtTime(0.005, now + 0.26);

    buzzOsc.connect(buzzGain);
    buzzGain.connect(audioCtx.destination);

    zapOsc.start(now);
    zapOsc.stop(now + duration);

    buzzOsc.start(now);
    buzzOsc.stop(now + 0.26);
}