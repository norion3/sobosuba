/**
 * sound.js
 * @version v4.0 (Final Overhaul Step 2)
 * @changes
 *   - 衝突音（playSoundCollide）に60msのスロットリング制御を追加し、複数ビーズ同時衝突による音割れ・多重発火を防止
 *   - 衝突音のピッチをゼリーの大きさ（jellyValue）に連動させ、小さいほど高め・大きいほど低めの自然なASMR質感へ改善
 *   - 上段飛び越えホップ（Bar-Hop）用の軽快な効果音 playSoundHop() を新規追加
 *   - 発射音・衝突音・連鎖ピッチ合体音・ゲームオーバーザップ音全体の音量バランスを最適化
 * 
 * Web Audio APIを使用した軽量サウンドモジュール
 * 
 * 外部の音声ファイルに依存せず、オシレーター（波形合成）を用いて
 * 「発射音」「ホップ音」「サイズ連動接触音」「合体音（連鎖ピッチ上昇対応）」「ゲームオーバーザップ音」を
 * 動的に生成・再生します。
 */

let audioCtx = null;

// 衝突音の多重発火・音割れを防ぐためのスロットリング管理（60ms）
let lastCollideSoundTime = 0;
const COLLIDE_THROTTLE_MS = 60;

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
 * 発射音（通常ショット／そっと落とし）
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
    if (!audioCtx) return;

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'sine';
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    const now = audioCtx.currentTime;

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
    // コンテキストが無い、または衝撃が弱すぎる（0.1未満）場合はスキップして処理を軽くする
    if (!audioCtx || intensity < 0.1) return;

    // 60ms以内の連続発火を制限し、中空ビーズ複数同時接触による音割れを防止
    const nowMs = performance.now();
    if (nowMs - lastCollideSoundTime < COLLIDE_THROTTLE_MS) return;
    lastCollideSoundTime = nowMs;

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'sine'; // 柔らかいぷるぷる感にするためサイン波を使用
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
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

    zapGain.gain.setValueAtTime(0.22, now);
    zapGain.gain.exponentialRampToValueAtTime(0.14, now + 0.14);
    zapGain.gain.exponentialRampToValueAtTime(0.005, now + duration);

    zapOsc.connect(zapGain);
    zapGain.connect(audioCtx.destination);

    // 2. ビリッとした衝撃感を補強する矩形波（短めのパルス変調）
    const buzzOsc = audioCtx.createOscillator();
    const buzzGain = audioCtx.createGain();
    buzzOsc.type = 'square';
    buzzOsc.frequency.setValueAtTime(160, now);
    buzzOsc.frequency.exponentialRampToValueAtTime(48, now + 0.26);

    buzzGain.gain.setValueAtTime(0.14, now);
    buzzGain.gain.exponentialRampToValueAtTime(0.005, now + 0.26);

    buzzOsc.connect(buzzGain);
    buzzGain.connect(audioCtx.destination);

    zapOsc.start(now);
    zapOsc.stop(now + duration);

    buzzOsc.start(now);
    buzzOsc.stop(now + 0.26);
}