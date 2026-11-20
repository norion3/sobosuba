/**
 * dom_ui.js
 * @version v8.0 (Start Guide Card, Refined GameOver Dark Card & HUD Stacking - Phase 5)
 * @changes
 *   - topHudHeader の z-index を 10 → 60 へ引き上げ、開始画面・ゲームオーバー画面表示中でも左上の音量 ON/OFF ボタンを常時操作可能にし、スコア表示ラッパー #topScoreWrapper を新設（showGameOverUI() で opacity: 0 非表示、hideGameOverUI() で opacity: 1 復帰）
 *   - 初回起動用の開始説明カードオーバーレイ（#startOverlay：タイトルなし・見出し「同じ数字をくっつけよう」・簡潔3行説明・#startBtn「TAP TO START」・オーバーレイ全体タップ開始可・全イベントバブリング遮断・350ms デバウンス）を追加し、showStartUI() / hideStartUI() をエクスポート、initUI() へ第3引数 onStartCallback を追加（省略時後方互換維持）
 *   - ゲームオーバー画面（#gameOverUI）から「両側のバンパーが押し込まれました」「FINAL」を削除し、backdrop-filter 不使用・下部 215px セーフエリア厳守のダークガラス調カード（GAME OVER ＋ 小さな SCORE ラベル ＋ 極太等幅ホワイト数字 ＋ 水滴アクア〜ブルーの「もう一度プレイ」<div> ボタン）へ刷新
 * 
 * 動的DOMマウント、HTML要素の更新、スコア表示、音量トグルUI、開始説明画面、および安全なUI制御を行うモジュール
 * 
 * くねくねバトル方式に則り、HTMLファイルにタグを直書きせず、
 * JS側から動的にCanvasやHUD要素を生成（マウント）します。
 * ※スイカゲーム風のNEXTプレビューUIおよびベストスコアUIは撤廃し、スコア表示・音量ON/OFFボタン・開始説明UI・ゲームオーバーUIを管理します。
 */

import { UI } from '/sobosuba/constants.js?v=7';

// DOM要素のキャッシュ
let elGameContainer;
let elCanvasStage;
let elTopScoreWrapper;
let elScoreDisplay;
let elSoundBtn;
let elSoundIcon;
let elSoundLabel;
let elStartOverlay;
let elStartBtn;
let elGameOverUI;
let elFinalScore;
let elWarningOverlay;
let elRetryBtn;

// 絵文字不使用の軽量インラインSVGスピーカーアイコン定義
const SVG_SPEAKER_OFF = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display: block; flex-shrink: 0;">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <line x1="23" y1="9" x2="17" y2="15"></line>
        <line x1="17" y1="9" x2="23" y2="15"></line>
    </svg>
`;

const SVG_SPEAKER_ON = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display: block; flex-shrink: 0;">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
    </svg>
`;

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

    // 2. 上部HUDヘッダー（GRAVITY上部ネイティブボタン帯回避 ＆ z-index: 60 により開始・終了画面でも音量操作可）
    const topHudHeader = document.createElement('div');
    topHudHeader.id = 'topHudHeader';
    topHudHeader.style.cssText = `
        position: relative;
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
        z-index: 60;
    `;
    topHudHeader.innerHTML = `
        <div id="topHudInnerRow" style="position: relative; width: 100%; max-width: 420px; min-height: 30px; display: flex; justify-content: center; align-items: center; pointer-events: none;">
            <!-- GRAVITY規格: <div> タグによる絵文字不使用のインラインSVG音量ON/OFFボタン（初期OFF・左端非干渉配置） -->
            <div id="soundToggleBtn" role="button" aria-label="音量切り替え" aria-pressed="false" style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); pointer-events: auto; display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 26px; padding: 3px 9px; border-radius: 9999px; border: 1px solid rgba(255, 255, 255, 0.16); background-color: rgba(255, 255, 255, 0.06); color: #9ca3af; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.06em; line-height: 1; cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: manipulation; box-sizing: border-box;">
                <span id="soundToggleIcon" style="display: inline-flex; align-items: center; justify-content: center; pointer-events: none;">${SVG_SPEAKER_OFF}</span>
                <span id="soundToggleLabel" style="pointer-events: none;">OFF</span>
            </div>

            <!-- 絶対中央維持スコア表示（ゲームオーバー表示時は非表示にして中央カードスコアを主役化） -->
            <div id="topScoreWrapper" style="display: inline-flex; flex-direction: row; align-items: baseline; justify-content: center; gap: 8px; padding: 2px 14px; color: white; font-weight: bold; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); pointer-events: none; transition: opacity 160ms ease;">
                <span style="font-size: 0.7rem; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.1em; line-height: 1;">Score</span>
                <span id="scoreDisplay" style="font-feature-settings: 'tnum'; font-size: 1.4rem; line-height: 1.1; color: #60a5fa;">0</span>
            </div>
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

    // 5. オーバーレイUIレイヤーの生成（警告エフェクト・開始説明カード・ゲームオーバー画面）
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

    // Tailwindを使わず、GRAVITY WebKit 規格準拠（backdrop-filter不使用・<div>ボタン・下部215pxセーフエリア）で安全にUIを構築
    uiLayer.innerHTML = `
        <!-- 警告表示用オーバーレイ -->
        <div id="warningOverlay" style="position: absolute; inset: 0; background-color: #ef4444; opacity: 0; pointer-events: none; transition: opacity 100ms; mix-blend-mode: screen; z-index: 0;"></div>

        <!-- Start Guide Overlay (初回起動時のみ表示・タイトルなし・簡潔3行説明・オーバーレイ全体タップ開始可) -->
        <div id="startOverlay" style="display: none; pointer-events: auto; background-color: rgba(4, 7, 15, 0.68); position: absolute; inset: 0; flex-direction: column; align-items: center; justify-content: center; padding-top: calc(env(safe-area-inset-top, 0px) + ${topPaddingPx}px); padding-right: 20px; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + min(${UI.SAFE_BOTTOM_PX}px, 32vh)); padding-left: 20px; box-sizing: border-box; overflow-y: auto; touch-action: none; overscroll-behavior: none; z-index: 45;">
            <div style="width: 100%; max-width: 340px; background-color: rgba(10, 16, 28, 0.92); border: 1px solid rgba(56, 189, 248, 0.28); border-radius: 22px; box-shadow: 0 20px 44px rgba(0, 0, 0, 0.65), 0 0 24px rgba(56, 189, 248, 0.10); padding: clamp(1.5rem, 3.8vh, 2.1rem) clamp(1.25rem, 5vw, 1.75rem); display: flex; flex-direction: column; align-items: center; text-align: center; margin: auto 0; box-sizing: border-box; user-select: none; -webkit-user-select: none;">
                <p style="color: #38bdf8; font-size: clamp(1.15rem, 4.8vw, 1.4rem); font-weight: 800; letter-spacing: 0.05em; line-height: 1.3; margin: 0 0 clamp(0.95rem, 2.6vh, 1.35rem) 0;">同じ数字をくっつけよう</p>

                <div style="display: flex; flex-direction: column; gap: clamp(0.45rem, 1.4vh, 0.68rem); color: #e2e8f0; font-size: clamp(0.84rem, 3.5vw, 0.96rem); font-weight: 500; line-height: 1.5; letter-spacing: 0.02em; margin: 0 0 clamp(1.25rem, 3.2vh, 1.7rem) 0;">
                    <p style="margin: 0;">引いて発射・タップでそっと落とす</p>
                    <p style="margin: 0;">上へ引くと となりの塊を飛びこえ</p>
                    <p style="margin: 0;">左右の赤いボタンが押されると終了</p>
                </div>

                <!-- GRAVITY規格: <div> タグによる開始ボタン -->
                <div id="startBtn" role="button" aria-label="ゲーム開始" style="pointer-events: auto; min-width: 210px; padding: clamp(0.75rem, 2vh, 0.95rem) clamp(1.6rem, 6vw, 2.2rem); border-radius: 9999px; border: 1.5px solid rgba(56, 189, 248, 0.58); background-color: rgba(56, 189, 248, 0.10); color: #38bdf8; font-size: clamp(0.95rem, 3.9vw, 1.08rem); font-weight: 800; letter-spacing: 0.16em; line-height: 1.1; box-shadow: 0 0 18px rgba(56, 189, 248, 0.24), inset 0 0 12px rgba(56, 189, 248, 0.10); display: inline-flex; justify-content: center; align-items: center; cursor: pointer; box-sizing: border-box;">
                    TAP TO START
                </div>
            </div>
        </div>

        <!-- Game Over UI (GRAVITY規格準拠: backdrop-filter不使用・ダークガラス調カード・下部215pxセーフエリア確保) -->
        <div id="gameOverUI" style="display: none; pointer-events: auto; background-color: rgba(4, 7, 15, 0.78); position: absolute; inset: 0; flex-direction: column; align-items: center; justify-content: center; padding-top: calc(env(safe-area-inset-top, 0px) + ${topPaddingPx}px); padding-right: 20px; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + min(${UI.SAFE_BOTTOM_PX}px, 32vh)); padding-left: 20px; box-sizing: border-box; overflow-y: auto; touch-action: none; overscroll-behavior: none; z-index: 50;">
            <div style="width: 100%; max-width: 340px; background-color: rgba(10, 16, 28, 0.92); border: 1px solid rgba(56, 189, 248, 0.28); border-radius: 22px; box-shadow: 0 20px 44px rgba(0, 0, 0, 0.7), 0 0 24px rgba(56, 189, 248, 0.10); padding: clamp(1.6rem, 4vh, 2.2rem) clamp(1.25rem, 5vw, 1.75rem); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: clamp(1rem, 2.8vh, 1.55rem); margin: auto 0; box-sizing: border-box; user-select: none; -webkit-user-select: none;">
                <h1 style="font-size: clamp(0.95rem, 3.8vw, 1.15rem); font-weight: 800; color: #fb7185; margin: 0; line-height: 1.2; letter-spacing: 0.22em;">GAME OVER</h1>

                <div style="text-align: center;">
                    <p style="color: #94a3b8; font-size: clamp(0.7rem, 2.8vw, 0.8rem); font-weight: 700; text-transform: uppercase; letter-spacing: 0.16em; margin: 0;">SCORE</p>
                    <p id="finalScore" style="color: #ffffff; font-size: clamp(2.75rem, 12vw, 4rem); font-weight: 800; font-feature-settings: 'tnum'; line-height: 1.05; margin: 0.25rem 0 0 0;">0</p>
                </div>

                <!-- GRAVITY規格: セーフエリア上に非干渉配置する <div> タグボタン -->
                <div style="width: 100%; flex-shrink: 0; margin-top: clamp(0.15rem, 0.8vh, 0.4rem); display: flex; justify-content: center;">
                    <div id="retryBtn" role="button" aria-label="もう一度プレイ" style="pointer-events: auto; width: 100%; max-width: 260px; background: linear-gradient(135deg, #38bdf8, #2563eb); color: #ffffff; font-weight: 800; font-size: clamp(0.98rem, 4vw, 1.12rem); letter-spacing: 0.08em; padding: clamp(0.8rem, 2.1vh, 1rem) clamp(1.5rem, 6vw, 2rem); border-radius: 14px; box-shadow: 0 8px 22px rgba(56, 189, 248, 0.35); display: inline-flex; justify-content: center; align-items: center; cursor: pointer; transition: transform 0.1s; box-sizing: border-box;">
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
 * @param {Function|null} [onToggleSoundCallback] - 音量ON/OFFボタンが押された時に実行されるコールバック関数
 * @param {Function|null} [onStartCallback] - 開始オーバーレイ／開始ボタンが押された時に実行されるコールバック関数
 */
export function initUI(onRetryCallback, onToggleSoundCallback = null, onStartCallback = null) {
    // 1. DOMを動的に生成してマウント
    mountDOM();

    // 2. DOM要素のキャッシュを取得
    elGameContainer = document.getElementById('game-container');
    elCanvasStage = document.getElementById('canvasStage');
    elTopScoreWrapper = document.getElementById('topScoreWrapper');
    elScoreDisplay = document.getElementById('scoreDisplay');
    elSoundBtn = document.getElementById('soundToggleBtn');
    elSoundIcon = document.getElementById('soundToggleIcon');
    elSoundLabel = document.getElementById('soundToggleLabel');
    elStartOverlay = document.getElementById('startOverlay');
    elStartBtn = document.getElementById('startBtn');
    elGameOverUI = document.getElementById('gameOverUI');
    elFinalScore = document.getElementById('finalScore');
    elWarningOverlay = document.getElementById('warningOverlay');
    elRetryBtn = document.getElementById('retryBtn');

    // 初期表示はデフォルト OFF を保証
    updateSoundUI(false);

    // =========================================================
    // 開始オーバーレイ（#startOverlay / #startBtn 全体タップ開始対応）のバインド
    // 裏の Canvas エイム操作へ貫通しないよう全8イベントで stopPropagation() と 350ms デバウンスを徹底
    // =========================================================
    if (elStartOverlay) {
        let lastStartTime = 0;
        let startTouchStartX = 0;
        let startTouchStartY = 0;
        let isStartTouchActive = false;

        const triggerStart = () => {
            const now = Date.now();
            if (now - lastStartTime < 350) return;
            lastStartTime = now;

            if (typeof onStartCallback === 'function') {
                onStartCallback();
            } else {
                hideStartUI();
            }
        };

        // マウス系4イベント（Canvas 操作へのバブリングを完全遮断）
        elStartOverlay.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });
        elStartOverlay.addEventListener('mousemove', (e) => {
            e.stopPropagation();
        });
        elStartOverlay.addEventListener('mouseup', (e) => {
            e.stopPropagation();
        });
        elStartOverlay.addEventListener('click', (e) => {
            e.stopPropagation();
            triggerStart();
        });

        // タッチ系4イベント（ラバーバンド現象 ＆ Canvas 操作への貫通を完全遮断）
        elStartOverlay.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            if (e.touches && e.touches.length > 0) {
                startTouchStartX = e.touches[0].clientX;
                startTouchStartY = e.touches[0].clientY;
                isStartTouchActive = true;
            }
        }, { passive: true });

        elStartOverlay.addEventListener('touchmove', (e) => {
            e.stopPropagation();
            if (e.cancelable) {
                e.preventDefault();
            }
        }, { passive: false });

        elStartOverlay.addEventListener('touchend', (e) => {
            e.stopPropagation();
            if (!isStartTouchActive) return;
            isStartTouchActive = false;

            if (e.changedTouches && e.changedTouches.length > 0) {
                const dx = e.changedTouches[0].clientX - startTouchStartX;
                const dy = e.changedTouches[0].clientY - startTouchStartY;
                const moveDist = Math.sqrt(dx * dx + dy * dy);
                if (moveDist <= 24) {
                    if (e.cancelable) {
                        e.preventDefault();
                    }
                    triggerStart();
                }
            }
        }, { passive: false });

        elStartOverlay.addEventListener('touchcancel', (e) => {
            e.stopPropagation();
            isStartTouchActive = false;
        }, { passive: true });
    }

    // =========================================================
    // 音量ON/OFFボタンのバインド
    // input.js との干渉ゼロを保証するため全8イベントで stopPropagation() を徹底
    // ＆ touchend/click の二重発火防止（iOS同期ユーザージェスチャー内で即コールバック実行）
    // =========================================================
    if (elSoundBtn) {
        let lastSoundToggleTime = 0;
        let soundTouchStartX = 0;
        let soundTouchStartY = 0;
        let isSoundTouchActive = false;

        const triggerSoundToggle = () => {
            const now = Date.now();
            if (now - lastSoundToggleTime < 350) return;
            lastSoundToggleTime = now;

            if (typeof onToggleSoundCallback === 'function') {
                const nextState = onToggleSoundCallback();
                if (typeof nextState === 'boolean') {
                    updateSoundUI(nextState);
                }
            }
        };

        // マウス系4イベント（window監視の input.js へのバブリングを完全遮断）
        elSoundBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });
        elSoundBtn.addEventListener('mousemove', (e) => {
            e.stopPropagation();
        });
        elSoundBtn.addEventListener('mouseup', (e) => {
            e.stopPropagation();
        });
        elSoundBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            triggerSoundToggle();
        });

        // タッチ系4イベント（window監視の input.js へのバブリングを完全遮断）
        elSoundBtn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            if (e.touches && e.touches.length > 0) {
                soundTouchStartX = e.touches[0].clientX;
                soundTouchStartY = e.touches[0].clientY;
                isSoundTouchActive = true;
            }
        }, { passive: true });

        elSoundBtn.addEventListener('touchmove', (e) => {
            e.stopPropagation();
        }, { passive: true });

        elSoundBtn.addEventListener('touchend', (e) => {
            e.stopPropagation();
            if (!isSoundTouchActive) return;
            isSoundTouchActive = false;

            if (e.changedTouches && e.changedTouches.length > 0) {
                const dx = e.changedTouches[0].clientX - soundTouchStartX;
                const dy = e.changedTouches[0].clientY - soundTouchStartY;
                const moveDist = Math.sqrt(dx * dx + dy * dy);
                if (moveDist <= 24) {
                    if (e.cancelable) {
                        e.preventDefault();
                    }
                    triggerSoundToggle();
                }
            }
        }, { passive: false });

        elSoundBtn.addEventListener('touchcancel', (e) => {
            e.stopPropagation();
            isSoundTouchActive = false;
        }, { passive: true });
    }

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
 * 音量ON/OFFボタンのインラインSVGアイコン・ラベル・配色を最新状態へ同期する
 * @param {boolean} isOn - 音量がONの場合は true、OFFの場合は false
 */
export function updateSoundUI(isOn) {
    if (!elSoundBtn) {
        elSoundBtn = document.getElementById('soundToggleBtn');
        elSoundIcon = document.getElementById('soundToggleIcon');
        elSoundLabel = document.getElementById('soundToggleLabel');
    }
    if (!elSoundBtn) return;

    const enabled = Boolean(isOn);
    elSoundBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');

    if (enabled) {
        elSoundBtn.style.color = '#60a5fa';
        elSoundBtn.style.borderColor = 'rgba(96, 165, 250, 0.48)';
        elSoundBtn.style.backgroundColor = 'rgba(96, 165, 250, 0.14)';
        if (elSoundIcon) elSoundIcon.innerHTML = SVG_SPEAKER_ON;
        if (elSoundLabel) elSoundLabel.textContent = 'ON';
    } else {
        elSoundBtn.style.color = '#9ca3af';
        elSoundBtn.style.borderColor = 'rgba(255, 255, 255, 0.16)';
        elSoundBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
        if (elSoundIcon) elSoundIcon.innerHTML = SVG_SPEAKER_OFF;
        if (elSoundLabel) elSoundLabel.textContent = 'OFF';
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
 * 互換維持用（ベストスコア表示の撤去に伴い処理なし・旧キャッシュ版 main.js とのインポート互換維持）
 */
export function updateBestScoreUI() {
    // 互換維持用（処理なし）
}

/**
 * 互換維持用（物理フロートバーへの移行に伴いHTMLプレビューは廃止）
 */
export function updateNextPreviewUI() {
    // 互換維持用（処理なし）
}

/**
 * 開始説明カードオーバーレイの表示（初回起動時）
 */
export function showStartUI() {
    if (!elStartOverlay) {
        elStartOverlay = document.getElementById('startOverlay');
    }
    if (elStartOverlay) {
        elStartOverlay.style.display = 'flex';
    }
}

/**
 * 開始説明カードオーバーレイの非表示（ゲーム開始・リトライ時）
 */
export function hideStartUI() {
    if (!elStartOverlay) {
        elStartOverlay = document.getElementById('startOverlay');
    }
    if (elStartOverlay) {
        elStartOverlay.style.display = 'none';
    }
}

/**
 * ゲームオーバー画面の表示（上部ヘッダースコアは非表示にして中央カードスコアを主役化）
 * @param {number} finalScore - 最終スコア
 */
export function showGameOverUI(finalScore) {
    if (elFinalScore) {
        elFinalScore.innerText = finalScore;
    }
    if (elTopScoreWrapper) {
        elTopScoreWrapper.style.opacity = '0';
    }
    if (elGameOverUI) {
        elGameOverUI.style.display = 'flex';
    }
}

/**
 * ゲームオーバー画面の非表示（リトライ時・上部ヘッダースコアを復帰）
 */
export function hideGameOverUI() {
    if (elTopScoreWrapper) {
        elTopScoreWrapper.style.opacity = '1';
    }
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