/**
 * dom_ui.js
 * 動的DOMマウント、HTML要素の更新、スコア表示、および安全なUI制御を行うモジュール
 * 
 * くねくねバトル方式に則り、HTMLファイルにタグを直書きせず、
 * JS側から動的にCanvasやHUD要素を生成（マウント）します。
 */

import { JELLY_CONFIG } from '/sobosuba/constants.js';

// DOM要素のキャッシュ
let elScoreDisplay;
let elNextPreviewContainer; // 待機列(キュー)用コンテナに変更
let elGameOverUI;
let elFinalScore;
let elWarningOverlay;
let elRetryBtn;

/**
 * ゲームのDOM構造を動的に生成してbodyにマウントする
 */
export function mountDOM() {
    // 既にマウントされていればスキップ
    if (document.getElementById('game-container')) return;

    // 1. ゲームコンテナの生成
    const gameContainer = document.createElement('div');
    gameContainer.id = 'game-container';
    gameContainer.style.cssText = `
        position: relative;
        width: 100vw;
        height: 100vh;
        display: flex;
        justify-content: center;
        align-items: center;
        background-color: #050505;
        overflow: hidden;
    `;
    document.body.appendChild(gameContainer);

    // 2. キャンバスの生成
    const canvas = document.createElement('canvas');
    canvas.id = 'gameCanvas';
    canvas.style.cssText = `
        background-color: #111111;
        touch-action: none;
    `;
    gameContainer.appendChild(canvas);

    // 3. UIレイヤーの生成
    const uiLayer = document.createElement('div');
    uiLayer.id = 'ui-layer';
    uiLayer.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-top: 2rem;
    `;
    
    // Tailwindを使わず、インラインスタイルで安全にUIを構築
    uiLayer.innerHTML = `
        <!-- スコア・Next待機列表示部 -->
        <div style="display: flex; justify-content: space-between; width: 100%; max-width: 420px; padding: 0 2rem; color: white; font-weight: bold; font-size: 1.5rem; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.3)); pointer-events: none; z-index: 10;">
            <div style="display: flex; flex-direction: column;">
                <span style="font-size: 0.75rem; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.1em;">Score</span>
                <span id="scoreDisplay" style="font-feature-settings: 'tnum'; font-size: 2.25rem; color: #60a5fa;">0</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end;">
                <span style="font-size: 0.75rem; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.5rem;">Next</span>
                <div id="nextPreviewContainer" style="display: flex; gap: 8px; align-items: center;">
                    <!-- 待機列(キュー)の要素がJSから動的に挿入されます -->
                </div>
            </div>
        </div>

        <!-- 警告表示用オーバーレイ -->
        <div id="warningOverlay" style="position: absolute; inset: 0; background-color: #ef4444; opacity: 0; pointer-events: none; transition: opacity 100ms; mix-blend-mode: screen; z-index: 0;"></div>

        <!-- Game Over UI (GRAVITY規格準拠: backdrop-filter不使用) -->
        <div id="gameOverUI" style="display: none; pointer-events: auto; background-color: rgba(0, 0, 0, 0.85); position: absolute; inset: 0; flex-direction: column; align-items: center; justify-content: center; z-index: 50;">
            <h1 style="font-size: 3rem; font-weight: 900; color: #ef4444; margin-bottom: 0.5rem; text-shadow: 0 0 15px rgba(239, 68, 68, 1); letter-spacing: 0.1em;">GAME OVER</h1>
            <p style="color: #fca5a5; font-size: 0.875rem; margin-bottom: 2rem;">両側のバンパーが押し込まれました</p>
            
            <div style="text-align: center; margin-bottom: 3rem;">
                <p style="color: #9ca3af; font-size: 1.125rem; text-transform: uppercase; letter-spacing: 0.05em;">Final Score</p>
                <p id="finalScore" style="color: #60a5fa; font-size: 4.5rem; font-weight: bold; font-feature-settings: 'tnum'; margin-top: 0.5rem; text-shadow: 0 4px 6px rgba(0,0,0,0.1);">0</p>
            </div>
            
            <!-- GRAVITY規格: 215pxセーフエリアに配置する <div> タグボタン -->
            <div style="position: absolute; bottom: calc(env(safe-area-inset-bottom, 0px) + 215px);">
                <div id="retryBtn" style="pointer-events: auto; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; font-weight: bold; font-size: 1.25rem; padding: 1rem 2.5rem; border-radius: 9999px; box-shadow: 0 0 20px rgba(59, 130, 246, 0.6); display: inline-flex; justify-content: center; align-items: center; cursor: pointer; transition: transform 0.1s;">
                    もう一度プレイ
                </div>
            </div>
        </div>
    `;
    gameContainer.appendChild(uiLayer);
}

/**
 * UI制御モジュールの初期化
 * @param {Function} onRetryCallback - リトライボタンが押された時に実行されるコールバック関数
 */
export function initUI(onRetryCallback) {
    // 1. DOMを動的に生成してマウント
    mountDOM();

    // 2. DOM要素のキャッシュを取得
    elScoreDisplay = document.getElementById('scoreDisplay');
    elNextPreviewContainer = document.getElementById('nextPreviewContainer');
    elGameOverUI = document.getElementById('gameOverUI');
    elFinalScore = document.getElementById('finalScore');
    elWarningOverlay = document.getElementById('warningOverlay');
    elRetryBtn = document.getElementById('retryBtn');

    // =========================================================
    // GRAVITY規格: ボタンタグを避け、<div> + stopPropagation でリトライを実装
    // =========================================================
    if (elRetryBtn) {
        // PC向けクリックイベント
        elRetryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onRetryCallback();
        });
        
        // スマホ向けタッチイベント（バブリング遮断のみ行い、動作遅延を防ぐ）
        elRetryBtn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
        }, { passive: true });
    }
}

/**
 * 現在のスコアを画面に反映（オプティカル・アライメント対応済みの要素へ出力）
 * @param {number} score 
 */
export function updateScoreUI(score) {
    if (elScoreDisplay) {
        elScoreDisplay.innerText = score;
    }
}

/**
 * 次に落ちてくるゼリーの待機列(キュー)プレビューUIを更新
 * @param {number|Array<number>} nextQueue - 次のゼリーの数字、または数字の配列
 */
export function updateNextPreviewUI(nextQueue) {
    if (!elNextPreviewContainer) return;
    
    // コンテナの中身をリセット
    elNextPreviewContainer.innerHTML = '';
    
    // メインロジック更新前(単一数値)と更新後(配列)の両方に対応
    const queue = Array.isArray(nextQueue) ? nextQueue : [nextQueue];

    queue.forEach((val, index) => {
        const config = JELLY_CONFIG[val];
        if (!config) return;

        const item = document.createElement('div');
        // 先頭（次に撃つもの）は大きく、後ろの待機列は小さく表示する設計
        const size = index === 0 ? '56px' : '36px';
        const fontSize = index === 0 ? '1.25rem' : '0.875rem';
        const borderWidth = index === 0 ? '2px' : '1px';

        item.style.cssText = `
            width: ${size};
            height: ${size};
            border-radius: 50%;
            border: ${borderWidth} solid white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: ${fontSize};
            font-weight: bold;
            font-feature-settings: 'tnum';
            box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
            background-color: ${config.color};
            color: ${config.text};
        `;
        item.innerText = val;
        elNextPreviewContainer.appendChild(item);
    });
}

/**
 * ゲームオーバー画面の表示
 * @param {number} finalScore - 最終スコア
 */
export function showGameOverUI(finalScore) {
    if (elFinalScore) {
        elFinalScore.innerText = finalScore;
    }
    if (elGameOverUI) {
        elGameOverUI.style.display = 'flex'; // hiddenクラスを廃止しdisplayで制御
    }
}

/**
 * ゲームオーバー画面の非表示（リトライ時）
 */
export function hideGameOverUI() {
    if (elGameOverUI) {
        elGameOverUI.style.display = 'none';
    }
}

/**
 * 左右のバンパーが押し込まれた際の赤色警告エフェクトの表示/非表示
 * @param {boolean} isActive - 警告エフェクトを有効にするかどうか
 */
export function setWarningEffect(isActive) {
    if (!elWarningOverlay) return;
    
    if (isActive) {
        elWarningOverlay.style.opacity = '0.25';
    } else {
        elWarningOverlay.style.opacity = '0';
    }
}