/**
 * input.js
 * @version v8.11 (Zero-Alloc Pointer State Snapshot - Phase 5)
 * @changes
 *   - getPointerState() の戻り値を事前確保オブジェクト（pointerStateSnapshot）のインプレース再利用へ変更し、ドラッグ中の毎フレーム一時オブジェクト生成（GC負荷）をゼロ化
 * 
 * タッチ/マウス操作の追従、順方向ダイレクトエイムの座標・ベクトル計算、
 * およびWebKit特有の余白ドラッグ(ラバーバンド)の物理遮断を管理する入力モジュール
 */

import { GAME_WIDTH, GAME_HEIGHT } from '/sobosuba/constants.js?v=7';

let canvasElement;
let scaleX = 1;
let scaleY = 1;
let rectLeft = 0;
let rectTop = 0;
let hasCachedRect = false;

// ポインタ・ドラッグ操作の現在状態（Sobo横移動時の毎フレーム指先追従用）
let isDragging = false;
let activeTouchId = null;
let suppressNextContextMenu = false;
let startX = 0;
let startY = 0;
let lastCurrentX = 0;
let lastCurrentY = 0;

// ドラッグ中毎フレームのGC負荷を削減する事前確保ポインタ状態スナップショット
const pointerStateSnapshot = {
    isDragging: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0
};

/**
 * 入力管理モジュールの初期化
 * @param {HTMLCanvasElement} canvas - 入力を監視する対象のキャンバス要素
 * @param {Function} onDragStart - ドラッグ開始時のコールバック (引数: startX, startY)
 * @param {Function} onDragUpdate - ドラッグ中のコールバック (引数: currentX, currentY, dragVectorX, dragVectorY)
 * @param {Function} onDragEnd - 指を離した（発射／キャンセル）時のコールバック ()
 * @param {Function|null} [onDragCancel=null] - OS割り込み・アプリ切替・右クリック等で安全キャンセルする際のコールバック ()
 */
export function initInput(canvas, onDragStart, onDragUpdate, onDragEnd, onDragCancel = null) {
    canvasElement = canvas;
    hasCachedRect = false;

    // 初回、ウィンドウリサイズ、およびスマホのvisualViewport変動時に位置・X/Y独立スケールを更新
    window.addEventListener('resize', updateScale);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateScale);
        window.visualViewport.addEventListener('scroll', updateScale);
    }
    updateScale();

    /**
     * ブラウザのクライアント座標から、ゲーム内(Canvas論理座標)のX/Y座標をキャッシュ済み矩形・独立スケールで算出
     * @param {number} clientX
     * @param {number} clientY
     * @param {boolean} [refreshRect=false] - ドラッグ開始時など最新矩形の再計測が必要な場合のみ true
     */
    function getRelativePoint(clientX, clientY, refreshRect = false) {
        if (!canvasElement) {
            return { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };
        }
        if (refreshRect || !hasCachedRect) {
            updateScale();
        }

        return {
            x: (clientX - rectLeft) / (scaleX || 1),
            y: (clientY - rectTop) / (scaleY || 1)
        };
    }

    /**
     * 開始画面・ゲームオーバーUI・音量ボタンなど、Canvas操作を除外すべきUI要素上のイベントか判定
     */
    function isIgnoredUITarget(target) {
        return Boolean(
            target &&
            typeof target.closest === 'function' &&
            target.closest('#gameOverUI, #startOverlay, #soundToggleBtn')
        );
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
        const pt = getRelativePoint(clientX, clientY, true);
        isDragging = true;
        startX = pt.x;
        startY = pt.y;
        lastCurrentX = pt.x;
        lastCurrentY = pt.y;
        onDragStart(startX, startY);
    }

    function handleDragMove(clientX, clientY) {
        if (!isDragging) return;
        const pt = getRelativePoint(clientX, clientY, false);
        const currentX = pt.x;
        const currentY = pt.y;

        lastCurrentX = currentX;
        lastCurrentY = currentY;

        const dx = currentX - startX;
        const dy = currentY - startY;

        onDragUpdate(currentX, currentY, dx, dy);
    }

    function handleDragEnd() {
        if (!isDragging) return;
        isDragging = false;

        // onDragEnd 側で最終的なベクトルを用いて発射またはキャンセル処理を行うよう委譲
        onDragEnd();
    }

    function handleDragCancel() {
        if (!isDragging && activeTouchId === null) return;
        isDragging = false;
        activeTouchId = null;

        // 割り込み・右クリック時は絶対に発射させず、安全キャンセルのみを実行
        if (typeof onDragCancel === 'function') {
            onDragCancel();
        }
    }

    // =========================================================
    // 1. マウス操作のバインド (PCブラウザ用)
    // =========================================================
    window.addEventListener('mousedown', (e) => {
        // タッチ操作中、またはUIレイヤー（ゲームオーバー画面のボタン等）へのクリックは無視する
        if (activeTouchId !== null || isIgnoredUITarget(e.target)) return;

        // ドラッグ中の右クリックで即キャンセル（直後のコンテキストメニューも抑止）
        if (e.button === 2) {
            if (isDragging) {
                suppressNextContextMenu = true;
                handleDragCancel();
            }
            return;
        }
        if (e.button !== 0) return;

        suppressNextContextMenu = false;
        handleDragStart(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
        if (activeTouchId !== null) return;
        handleDragMove(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', (e) => {
        if (activeTouchId !== null || e.button !== 0) return;
        handleDragEnd();
    });

    window.addEventListener('contextmenu', (e) => {
        if (isDragging || suppressNextContextMenu) {
            suppressNextContextMenu = false;
            e.preventDefault();
            if (isDragging) {
                handleDragCancel();
            }
        }
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
            handleDragCancel();
        }
    });

    // =========================================================
    // 3. OS通知・アプリ切替・タブ非表示時の誤発射・タッチ操作固着防止
    // =========================================================
    function handlePointerInterruption() {
        if (activeTouchId === null && !isDragging) return;
        suppressNextContextMenu = false;
        handleDragCancel();
    }

    window.addEventListener('blur', handlePointerInterruption);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            handlePointerInterruption();
        }
    });
}

/**
 * ゲームオーバー・リトライ時にポインタおよびドラッグ追跡状態を安全に初期化する
 */
export function resetInputState() {
    isDragging = false;
    activeTouchId = null;
    suppressNextContextMenu = false;
    startX = 0;
    startY = 0;
    lastCurrentX = 0;
    lastCurrentY = 0;
}

/**
 * 現在のポインタ論理座標とドラッグ状態を返す（事前確保スナップショット再利用によるゼロアロケーション）
 * （指を静止させた状態でSoboがバー上を横移動した際も、毎フレーム指先方向へ矢印を追従させるために使用）
 * @returns {{ isDragging: boolean, startX: number, startY: number, currentX: number, currentY: number }}
 */
export function getPointerState() {
    pointerStateSnapshot.isDragging = isDragging;
    pointerStateSnapshot.startX = startX;
    pointerStateSnapshot.startY = startY;
    pointerStateSnapshot.currentX = lastCurrentX;
    pointerStateSnapshot.currentY = lastCurrentY;
    return pointerStateSnapshot;
}

/**
 * CanvasのCSS上での表示位置・サイズと、内部論理座標(GAME_WIDTH / GAME_HEIGHT)とのX/Y独立比率を更新・キャッシュする
 * (動的リサイズ・高解像度DPR描画時にもマウス・タッチ座標のズレとドラッグ中の不要リフローを防止)
 */
export function updateScale() {
    if (!canvasElement) return;
    const rect = canvasElement.getBoundingClientRect();
    rectLeft = rect.left;
    rectTop = rect.top;
    if (rect.width > 0) {
        scaleX = rect.width / GAME_WIDTH;
    }
    if (rect.height > 0) {
        scaleY = rect.height / GAME_HEIGHT;
    }
    hasCachedRect = true;
}