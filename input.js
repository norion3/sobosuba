/**
 * input.js
 * @version v4.0 (Final Overhaul Step 4)
 * @changes
 *   - 操作中の指の識別子（activeTouchId）を追跡することで、ドラッグ中に2本目の指や手のひらが画面に触れて離れても発射が暴発しないマルチタッチ誤爆防止を実装
 *   - iOS Safari / GRAVITY WebView での長押しエイム時にOS側の拡大鏡・テキスト選択メニューが介入するのを防ぐため、UI対象外の touchstart で安全に preventDefault() を実行
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスを /sobosuba/constants.js?v=4 へ統一
 * 
 * タッチ/マウス操作の追従、順方向ダイレクトエイムの座標・ベクトル計算、
 * およびWebKit特有の余白ドラッグ(ラバーバンド)の物理遮断を管理する入力モジュール
 */

import { GAME_WIDTH, GAME_HEIGHT, PHYSICS } from '/sobosuba/constants.js?v=4';

let canvasElement;
let scaleX = 1;
let scaleY = 1;

// ポインタ・ドラッグ操作の現在状態（Sobo横移動時の毎フレーム指先追従用）
let isDragging = false;
let activeTouchId = null;
let startX = 0;
let startY = 0;
let lastCurrentX = 0;
let lastCurrentY = 0;

/**
 * 入力管理モジュールの初期化
 * @param {HTMLCanvasElement} canvas - 入力を監視する対象のキャンバス要素
 * @param {Function} onDragStart - ドラッグ開始時のコールバック (引数: startX, startY)
 * @param {Function} onDragUpdate - ドラッグ中のコールバック (引数: currentX, currentY, dragVectorX, dragVectorY)
 * @param {Function} onDragEnd - 指を離した（発射／キャンセル）時のコールバック ()
 */
export function initInput(canvas, onDragStart, onDragUpdate, onDragEnd) {
    canvasElement = canvas;

    // 初回、ウィンドウリサイズ、およびスマホのvisualViewport変動時にX/Y独立スケールを更新
    window.addEventListener('resize', updateScale);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateScale);
        window.visualViewport.addEventListener('scroll', updateScale);
    }
    updateScale();

    /**
     * ブラウザのクライアント座標から、ゲーム内(Canvas論理座標)のX/Y座標を独立スケールで厳密算出
     */
    function getRelativePoint(clientX, clientY) {
        if (!canvasElement) {
            return { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };
        }
        const rect = canvasElement.getBoundingClientRect();
        const curScaleX = rect.width > 0 ? (rect.width / GAME_WIDTH) : scaleX;
        const curScaleY = rect.height > 0 ? (rect.height / GAME_HEIGHT) : scaleY;

        scaleX = curScaleX;
        scaleY = curScaleY;

        return {
            x: (clientX - rect.left) / curScaleX,
            y: (clientY - rect.top) / curScaleY
        };
    }

    /**
     * ゲームオーバーUIなど、Canvas操作を除外すべきUI要素上のイベントか判定
     */
    function isIgnoredUITarget(target) {
        return Boolean(target && typeof target.closest === 'function' && target.closest('#gameOverUI'));
    }

    /**
     * TouchList から指定した identifier のタッチオブジェクトを検索する
     */
    function findTouchById(touchList, id) {
        if (!touchList || id === null) return null;
        for (let i = 0; i < touchList.length; i++) {
            if (touchList[i].identifier === id) {
                return touchList[i];
            }
        }
        return null;
    }

    // =========================================================
    // 順方向ダイレクトエイム操作の共通関数
    // =========================================================
    function handleDragStart(clientX, clientY) {
        const pt = getRelativePoint(clientX, clientY);
        isDragging = true;
        startX = pt.x;
        startY = pt.y;
        lastCurrentX = pt.x;
        lastCurrentY = pt.y;
        onDragStart(startX, startY);
    }

    function handleDragMove(clientX, clientY) {
        if (!isDragging) return;
        const pt = getRelativePoint(clientX, clientY);
        const currentX = pt.x;
        const currentY = pt.y;

        lastCurrentX = currentX;
        lastCurrentY = currentY;

        let dx = currentX - startX;
        let dy = currentY - startY;

        // 最大ドラッグ距離の制限（クランプ）
        const maxDrag = PHYSICS.AIM_MAX_DRAG || PHYSICS.SLINGSHOT_MAX_DRAG || 150;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > maxDrag) {
            const ratio = maxDrag / distance;
            dx *= ratio;
            dy *= ratio;
        }

        onDragUpdate(currentX, currentY, dx, dy);
    }

    function handleDragEnd() {
        if (!isDragging) return;
        isDragging = false;

        // onDragEnd 側で最終的なベクトルを用いて発射またはキャンセル処理を行うよう委譲
        onDragEnd();
    }

    // =========================================================
    // 1. マウス操作のバインド (PCブラウザ用)
    // =========================================================
    window.addEventListener('mousedown', (e) => {
        // タッチ操作中、またはUIレイヤー（ゲームオーバー画面のボタン等）へのクリックは無視する
        if (activeTouchId !== null || isIgnoredUITarget(e.target)) return;
        handleDragStart(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
        if (activeTouchId !== null) return;
        handleDragMove(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', () => {
        if (activeTouchId !== null) return;
        handleDragEnd();
    });

    // =========================================================
    // 2. タッチ操作のバインド (スマートフォン・GRAVITYアプリ用)
    // =========================================================
    window.addEventListener('touchstart', (e) => {
        if (isIgnoredUITarget(e.target)) return;

        // iOS Safari / GRAVITY WebView 対策：長押しエイム時の拡大鏡・選択メニュー介入を防止
        if (e.cancelable) {
            e.preventDefault();
        }

        // マルチタッチ誤爆防止：既に別の指で操作中なら2本目以降の指は無視する
        if (activeTouchId !== null || isDragging) return;

        const touch = (e.changedTouches && e.changedTouches.length > 0)
            ? e.changedTouches[0]
            : ((e.touches && e.touches.length > 0) ? e.touches[0] : null);

        if (touch) {
            activeTouchId = touch.identifier;
            handleDragStart(touch.clientX, touch.clientY);
        }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
        // GRAVITY規格: 余白ドラッグによるOS背景露出（ラバーバンド現象）の物理遮断
        if (e.cancelable) {
            e.preventDefault();
        }
        if (activeTouchId === null) return;

        // 追跡中の操作指（activeTouchId）の座標のみを反映
        const activeTouch = findTouchById(e.touches, activeTouchId);
        if (activeTouch) {
            handleDragMove(activeTouch.clientX, activeTouch.clientY);
        }
    }, { passive: false }); // preventDefault()を有効にするため passive: false を明示

    window.addEventListener('touchend', (e) => {
        if (activeTouchId === null) return;

        // 追跡中の操作指が離れた場合のみドラッグ終了（他の指の離脱による暴発を完全防止）
        const endedTouch = findTouchById(e.changedTouches, activeTouchId);
        if (endedTouch) {
            activeTouchId = null;
            handleDragEnd();
        }
    });

    window.addEventListener('touchcancel', (e) => {
        if (activeTouchId === null) return;

        const canceledTouch = findTouchById(e.changedTouches, activeTouchId);
        if (canceledTouch) {
            activeTouchId = null;
            handleDragEnd();
        }
    });
}

/**
 * 現在のポインタ論理座標とドラッグ状態を返す
 * （指を静止させた状態でSoboがバー上を横移動した際も、毎フレーム指先方向へ矢印を追従させるために使用）
 * @returns {{ isDragging: boolean, startX: number, startY: number, currentX: number, currentY: number }}
 */
export function getPointerState() {
    return {
        isDragging,
        startX,
        startY,
        currentX: lastCurrentX,
        currentY: lastCurrentY
    };
}

/**
 * CanvasのCSS上での表示サイズと、内部論理座標(GAME_WIDTH / GAME_HEIGHT)とのX/Y独立比率を更新する
 * (動的リサイズ・高解像度DPR描画時にもマウス・タッチ座標のズレを完全に防ぐ)
 */
export function updateScale() {
    if (!canvasElement) return;
    const rect = canvasElement.getBoundingClientRect();
    if (rect.width > 0) {
        scaleX = rect.width / GAME_WIDTH;
    }
    if (rect.height > 0) {
        scaleY = rect.height / GAME_HEIGHT;
    }
}