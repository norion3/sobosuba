/**
 * dom_ui.js
 * @version v2.0 (Bugfix Step 2)
 * @changes
 *   - スコア表示をコンパクト化し、画面最上部セーフエリア内へ配置してフロートバーとの重なりを解消
 *   - スマホ / iOS WebView 環境向けにリトライボタンの touchend 反応対応と二重発火防止を追加
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスに ?v=2 を付与
 * 
 * 動的DOMマウント、HTML要素の更新、スコア表示、および安全なUI制御を行うモジュール
 * 
 * くねくねバトル方式に則り、HTMLファイルにタグを直書きせず、
 * JS側から動的にCanvasやHUD要素を生成（マウント）します。
 * ※スイカゲーム風のNEXTプレビューUIは撤廃し、スコア表示とゲームオーバーUIのみを管理します。
 */

import { JELLY_CONFIG } from '/sobosuba/constants.js?v=2';

// DOM要素のキャッシュ
let elScoreDisplay;
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
        padding-top: calc(env(safe-area-inset-top, 0px) + 6px);
    `;
    
    // Tailwindを使わず、インラインスタイルで安全にUIを構築（スコアをコンパクト化しフロートバーとの重なりを解消）
    uiLayer.innerHTML = `
        <!-- スコア表示部（上部セーフエリア内にコンパクト配置） -->
        <div style="display: flex; justify-content: flex-start; align-items: center; width: 100%; max-width: 420px; padding: 2px 14px; color: white; font-weight: bold; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); pointer-events: none; z-index: 10;">
            <div style="display: flex; flex-direction: row; align-items: baseline; gap: 8px;">
                <span style="font-size: 0.65rem; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.08em; line-height: 1;">Score</span>
                <span id="scoreDisplay" style="font-feature-settings: 'tnum'; font-size: 1.35rem; line-height: 1.1; color: #60a5fa;">0</span>
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
    elGameOverUI = document.getElementById('gameOverUI');
    elFinalScore = document.getElementById('finalScore');
    elWarningOverlay = document.getElementById('warningOverlay');
    elRetryBtn = document.getElementById('retryBtn');

    // =========================================================
    // GRAVITY規格: ボタンタグを避け、<div> + stopPropagation でリトライを実装
    // iOS / GRAVITY WebView での1タップ確実反応（touchend）と二重発火防止を追加
    // =========================================================
    if (elRetryBtn) {
        let lastRetryTime = 0;
        let touchStartX = 0;
        let touchStartY = 0;
        let isTouchActive = false;

        const triggerRetry = () => {
            const now = Date.now();
            // touchend と直後の合成 click による二重発火を防止
            if (now - lastRetryTime < 350) return;
            lastRetryTime = now;
            onRetryCallback();
        };

        // PC向けクリックイベント
        elRetryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            triggerRetry();
        });
        
        // スマホ向けタッチ開始イベント（バブリング遮断と開始座標記録）
        elRetryBtn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            if (e.touches && e.touches.length > 0) {
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                isTouchActive = true;
            }
        }, { passive: true });

        // スマホ・iOS WebView向けタッチ終了イベント（わずかな指のズレを許容して確実に反応）
        elRetryBtn.addEventListener('touchend', (e) => {
            e.stopPropagation();
            if (!isTouchActive) return;
            isTouchActive = false;

            if (e.changedTouches && e.changedTouches.length > 0) {
                const dx = e.changedTouches[0].clientX - touchStartX;
                const dy = e.changedTouches[0].clientY - touchStartY;
                const moveDist = Math.sqrt(dx * dx + dy * dy);
                // 指のズレが24px以内ならタップとみなして発火
                if (moveDist <= 24) {
                    if (e.cancelable) {
                        e.preventDefault();
                    }
                    triggerRetry();
                }
            }
        }, { passive: false });
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
 * 互換維持用（物理フロートバーへの移行に伴いHTMLプレビューは廃止）
 */
export function updateNextPreviewUI() {
    // 何もしない（Step 7でのmain.js統合までインポート互換を維持）
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
        elGameOverUI.style.display = 'flex';
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