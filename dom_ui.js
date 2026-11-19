/**
 * dom_ui.js
 * @version v4.0 (Final Overhaul Step 3)
 * @changes
 *   - ゲームオーバー画面のリトライボタン絶対配置を廃止し、小画面（iPhone SE等）や横向き表示でも Final Score とリトライボタンが絶対に重ならない安全なFlexリザルトレイアウトへ修正（GRAVITY下部215pxセーフエリア維持）
 *   - GRAVITYアプリ内WebViewと通常ブラウザ（Safari / Chrome / PC等）を自動判別し、上部ヘッダー余白を UI.SAFE_TOP_HEADER_PX / UI.SAFE_TOP_HEADER_BROWSER_PX へ最適化
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスを /sobosuba/constants.js?v=4 へ統一
 * 
 * 動的DOMマウント、HTML要素の更新、スコア表示、および安全なUI制御を行うモジュール
 * 
 * くねくねバトル方式に則り、HTMLファイルにタグを直書きせず、
 * JS側から動的にCanvasやHUD要素を生成（マウント）します。
 * ※スイカゲーム風のNEXTプレビューUIは撤廃し、スコア表示とゲームオーバーUIのみを管理します。
 */

import { UI } from '/sobosuba/constants.js?v=4';

// DOM要素のキャッシュ
let elGameContainer;
let elCanvasStage;
let elScoreDisplay;
let elGameOverUI;
let elFinalScore;
let elWarningOverlay;
let elRetryBtn;

/**
 * GRAVITYアプリ内WebViewかどうかを判別し、最適な上部ヘッダー余白（px）を返す
 * @returns {number} 上部追加余白（px）
 */
function getOptimalTopHeaderPaddingPx() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
    const isGravityUA = /gravity/i.test(ua);
    const isAndroidWebView = /;\s*wv\)/i.test(ua);
    const isIOSDevice = /(iPhone|iPad|iPod)/i.test(ua);
    const isIOSWebView = isIOSDevice && !/Safari\//i.test(ua);
    const hasWKBridge = Boolean(
        typeof window !== 'undefined' &&
        window.webkit &&
        window.webkit.messageHandlers
    );

    if (isGravityUA || isAndroidWebView || isIOSWebView || hasWKBridge) {
        return UI.SAFE_TOP_HEADER_PX;
    }
    return (UI.SAFE_TOP_HEADER_BROWSER_PX !== undefined) ? UI.SAFE_TOP_HEADER_BROWSER_PX : 8;
}

/**
 * ゲームのDOM構造を動的に生成してbodyにマウントする
 */
export function mountDOM() {
    // 既にマウントされていればスキップ
    if (document.getElementById('game-container')) return;

    const topPaddingPx = getOptimalTopHeaderPaddingPx();

    // 1. ゲームコンテナの生成（visualViewport 連動の縦横自動レイアウト基盤）
    const gameContainer = document.createElement('div');
    gameContainer.id = 'game-container';
    gameContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        align-items: center;
        background-color: #050505;
        overflow: hidden;
        box-sizing: border-box;
    `;
    document.body.appendChild(gameContainer);

    // 2. 上部HUDヘッダー（GRAVITY上部ネイティブボタン帯回避 ＆ 通常ブラウザ余白最適化）
    const topHudHeader = document.createElement('div');
    topHudHeader.id = 'topHudHeader';
    topHudHeader.style.cssText = `
        width: 100%;
        flex: 0 0 auto;
        display: flex;
        justify-content: center;
        align-items: center;
        padding-top: calc(env(safe-area-inset-top, 0px) + ${topPaddingPx}px);
        padding-bottom: 4px;
        padding-left: 16px;
        padding-right: 16px;
        box-sizing: border-box;
        pointer-events: none;
        z-index: 10;
    `;
    topHudHeader.innerHTML = `
        <div style="display: inline-flex; flex-direction: row; align-items: baseline; justify-content: center; gap: 8px; padding: 2px 14px; color: white; font-weight: bold; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));">
            <span style="font-size: 0.7rem; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.1em; line-height: 1;">Score</span>
            <span id="scoreDisplay" style="font-feature-settings: 'tnum'; font-size: 1.4rem; line-height: 1.1; color: #60a5fa;">0</span>
        </div>
    `;
    gameContainer.appendChild(topHudHeader);

    // 3. 伸縮キャンバスステージ（残りの縦横空間へCanvasを自動フィットさせる領域）
    const canvasStage = document.createElement('div');
    canvasStage.id = 'canvasStage';
    canvasStage.style.cssText = `
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        width: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 0 ${UI.CANVAS_MARGIN_X}px calc(env(safe-area-inset-bottom, 0px) + ${UI.CANVAS_MARGIN_BOTTOM}px) ${UI.CANVAS_MARGIN_X}px;
        box-sizing: border-box;
        overflow: hidden;
    `;
    gameContainer.appendChild(canvasStage);

    // 4. キャンバスの生成
    const canvas = document.createElement('canvas');
    canvas.id = 'gameCanvas';
    canvas.style.cssText = `
        display: block;
        background-color: #080808;
        touch-action: none;
    `;
    canvasStage.appendChild(canvas);

    // 5. オーバーレイUIレイヤーの生成（警告エフェクト・ゲームオーバー画面）
    const uiLayer = document.createElement('div');
    uiLayer.id = 'ui-layer';
    uiLayer.style.cssText = `
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        z-index: 20;
    `;

    // Tailwindを使わず、インラインスタイルで安全にUIを構築
    // 小画面でも Final Score とリトライボタンが絶対に重ならない安全なFlexリザルト構造
    uiLayer.innerHTML = `
        <!-- 警告表示用オーバーレイ -->
        <div id="warningOverlay" style="position: absolute; inset: 0; background-color: #ef4444; opacity: 0; pointer-events: none; transition: opacity 100ms; mix-blend-mode: screen; z-index: 0;"></div>

        <!-- Game Over UI (GRAVITY規格準拠: backdrop-filter不使用・215pxセーフエリア確保のFlexレイアウト) -->
        <div id="gameOverUI" style="display: none; pointer-events: auto; background-color: rgba(0, 0, 0, 0.85); position: absolute; inset: 0; flex-direction: column; align-items: center; justify-content: center; padding-top: calc(env(safe-area-inset-top, 0px) + ${topPaddingPx}px); padding-right: 16px; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + min(${UI.SAFE_BOTTOM_PX}px, 32vh)); padding-left: 16px; box-sizing: border-box; overflow-y: auto; z-index: 50;">
            <div style="width: 100%; max-width: 380px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: clamp(0.75rem, 2.5vh, 1.75rem); margin: auto 0;">
                <div style="text-align: center;">
                    <h1 style="font-size: clamp(2rem, 8vw, 3rem); font-weight: 900; color: #ef4444; margin: 0 0 0.4rem 0; line-height: 1.1; text-shadow: 0 0 15px rgba(239, 68, 68, 1); letter-spacing: 0.1em;">GAME OVER</h1>
                    <p style="color: #fca5a5; font-size: clamp(0.75rem, 3.2vw, 0.875rem); margin: 0;">両側のバンパーが押し込まれました</p>
                </div>

                <div style="text-align: center;">
                    <p style="color: #9ca3af; font-size: clamp(0.875rem, 3.5vw, 1.125rem); text-transform: uppercase; letter-spacing: 0.05em; margin: 0;">Final Score</p>
                    <p id="finalScore" style="color: #60a5fa; font-size: clamp(2.75rem, 12vw, 4.5rem); font-weight: bold; font-feature-settings: 'tnum'; line-height: 1.1; margin: 0.35rem 0 0 0; text-shadow: 0 4px 6px rgba(0,0,0,0.1);">0</p>
                </div>

                <!-- GRAVITY規格: セーフエリア上に非干渉配置する <div> タグボタン -->
                <div style="flex-shrink: 0; margin-top: clamp(0.25rem, 1.5vh, 0.75rem);">
                    <div id="retryBtn" style="pointer-events: auto; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; font-weight: bold; font-size: clamp(1rem, 4.2vw, 1.25rem); padding: clamp(0.75rem, 2vh, 1rem) clamp(1.75rem, 7vw, 2.5rem); border-radius: 9999px; box-shadow: 0 0 20px rgba(59, 130, 246, 0.6); display: inline-flex; justify-content: center; align-items: center; cursor: pointer; transition: transform 0.1s;">
                        もう一度プレイ
                    </div>
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
    elGameContainer = document.getElementById('game-container');
    elCanvasStage = document.getElementById('canvasStage');
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
 * visualViewport から取得した実表示サイズをゲームコンテナへ同期する
 * @param {number} width - ビューポート実幅（px）
 * @param {number} height - ビューポート実高（px）
 * @param {number} offsetTop - ビューポート上オフセット（px）
 * @param {number} offsetLeft - ビューポート左オフセット（px）
 */
export function applyViewportSize(width, height, offsetTop = 0, offsetLeft = 0) {
    if (!elGameContainer) {
        elGameContainer = document.getElementById('game-container');
    }
    if (!elGameContainer) return;

    elGameContainer.style.width = `${Math.round(width)}px`;
    elGameContainer.style.height = `${Math.round(height)}px`;
    elGameContainer.style.top = `${Math.round(offsetTop)}px`;
    elGameContainer.style.left = `${Math.round(offsetLeft)}px`;
}

/**
 * Canvasを配置する伸縮ステージ要素を取得する（自動縦横フィット計算用）
 * @returns {HTMLElement|null}
 */
export function getCanvasStageElement() {
    if (!elCanvasStage) {
        elCanvasStage = document.getElementById('canvasStage');
    }
    return elCanvasStage;
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
    // 互換維持用（処理なし）
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