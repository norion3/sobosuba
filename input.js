/**
 * input.js
 * タッチ/マウス操作の追従、スリングショット（引っ張り発射）のベクトル計算、
 * およびWebKit特有の余白ドラッグ(ラバーバンド)の物理遮断を管理する入力モジュール
 */

import { GAME_WIDTH, GAME_HEIGHT, PHYSICS } from '/sobosuba/constants.js';

let canvasElement;
let scaleRatio = 1;

// スリングショット用の状態管理
let isDragging = false;
let startX = 0;
let startY = 0;

/**
 * 入力管理モジュールの初期化
 * @param {HTMLCanvasElement} canvas - 入力を監視する対象のキャンバス要素
 * @param {Function} onDragStart - 引っ張り開始時のコールバック (引数: startX, startY)
 * @param {Function} onDragUpdate - 引っ張り中のコールバック (引数: currentX, currentY, dragVectorX, dragVectorY)
 * @param {Function} onDragEnd - 指を離した（発射）時のコールバック ()
 */
export function initInput(canvas, onDragStart, onDragUpdate, onDragEnd) {
    canvasElement = canvas;
    
    // 初回とウィンドウのリサイズ時に表示スケールを計算
    window.addEventListener('resize', updateScale);
    updateScale();

    /**
     * ブラウザのクライアントX座標から、ゲーム内(Canvas内)の相対X座標を算出
     */
    function getRelativeX(clientX) {
        if (!canvasElement) return GAME_WIDTH / 2;
        const rect = canvasElement.getBoundingClientRect();
        return (clientX - rect.left) / scaleRatio;
    }

    /**
     * ブラウザのクライアントY座標から、ゲーム内(Canvas内)の相対Y座標を算出
     */
    function getRelativeY(clientY) {
        if (!canvasElement) return GAME_HEIGHT / 2;
        const rect = canvasElement.getBoundingClientRect();
        return (clientY - rect.top) / scaleRatio;
    }

    // =========================================================
    // スリングショット操作の共通関数
    // =========================================================
    function handleDragStart(clientX, clientY) {
        isDragging = true;
        startX = getRelativeX(clientX);
        startY = getRelativeY(clientY);
        onDragStart(startX, startY);
    }

    function handleDragMove(clientX, clientY) {
        if (!isDragging) return;
        const currentX = getRelativeX(clientX);
        const currentY = getRelativeY(clientY);
        
        let dx = currentX - startX;
        let dy = currentY - startY;

        // 最大引っ張り距離の制限（クランプ）
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > PHYSICS.SLINGSHOT_MAX_DRAG) {
            const ratio = PHYSICS.SLINGSHOT_MAX_DRAG / distance;
            dx *= ratio;
            dy *= ratio;
        }

        onDragUpdate(currentX, currentY, dx, dy);
    }

    function handleDragEnd() {
        if (!isDragging) return;
        isDragging = false;
        
        // onDragEnd 側で最終的なベクトルを用いて発射処理を行うよう委譲
        onDragEnd();
    }

    // =========================================================
    // 1. マウス操作のバインド (PCブラウザ用)
    // =========================================================
    window.addEventListener('mousedown', (e) => {
        // UIレイヤー（ゲームオーバー画面のボタン等）へのクリックは無視する
        if (e.target.closest('#gameOverUI')) return;
        handleDragStart(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
        handleDragMove(e.clientX, e.clientY);
    });
    
    window.addEventListener('mouseup', (e) => {
        handleDragEnd();
    });

    // =========================================================
    // 2. タッチ操作のバインド (スマートフォン・GRAVITYアプリ用)
    // =========================================================
    window.addEventListener('touchstart', (e) => {
        if (e.target.closest('#gameOverUI')) return;
        if (e.touches.length > 0) {
            handleDragStart(e.touches[0].clientX, e.touches[0].clientY);
        }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
        // GRAVITY規格: 余白ドラッグによるOS背景露出（ラバーバンド現象）の物理遮断
        if (e.cancelable) {
            e.preventDefault();
        }
        if (e.touches.length > 0) {
            handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
        }
    }, { passive: false }); // preventDefault()を有効にするため passive: false を明示

    window.addEventListener('touchend', (e) => {
        handleDragEnd();
    });
}

/**
 * CanvasのCSS上での表示サイズと、内部解像度(GAME_WIDTH)との比率を更新する
 * (レスポンシブ対応時にマウス・タッチ座標のズレを防ぐため)
 */
export function updateScale() {
    if (!canvasElement) return;
    const rect = canvasElement.getBoundingClientRect();
    if (rect.width > 0) {
        scaleRatio = rect.width / GAME_WIDTH;
    }
}