/**
 * input.js
 * タッチ/マウス操作の追従、ゼリーの落下指令の発行、
 * およびWebKit特有の余白ドラッグ(ラバーバンド)の物理遮断を管理する入力モジュール
 */

import { GAME_WIDTH } from '/sobosuba/constants.js';

let canvasElement;
let scaleRatio = 1;

/**
 * 入力管理モジュールの初期化
 * @param {HTMLCanvasElement} canvas - 入力を監視する対象のキャンバス要素
 * @param {Function} onMoveCallback - X座標が移動した際に呼ばれるコールバック (引数: relativeX)
 * @param {Function} onDropCallback - 画面がタップ・クリックされてドロップが指示された際に呼ばれるコールバック
 */
export function initInput(canvas, onMoveCallback, onDropCallback) {
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
        // キャンバス左端からのピクセル数を求め、表示スケールで割ることで内部座標へ変換
        return (clientX - rect.left) / scaleRatio;
    }

    // =========================================================
    // 1. マウス操作のバインド (PCブラウザ用)
    // =========================================================
    window.addEventListener('mousemove', (e) => {
        onMoveCallback(getRelativeX(e.clientX));
    });
    
    window.addEventListener('mousedown', (e) => {
        // UIレイヤー（ゲームオーバー画面のボタン等）へのクリックは無視する
        if (e.target.closest('#gameOverUI')) return;
        
        onMoveCallback(getRelativeX(e.clientX));
        onDropCallback();
    });

    // =========================================================
    // 2. タッチ操作のバインド (スマートフォン・GRAVITYアプリ用)
    // =========================================================
    window.addEventListener('touchmove', (e) => {
        // GRAVITY規格: 余白ドラッグによるOS背景露出（ラバーバンド現象）の物理遮断
        // スクロールが必要なUIがないため、キャンバス上のスワイプは全てスクロールを無効化
        if (e.cancelable) {
            e.preventDefault();
        }
        if (e.touches.length > 0) {
            onMoveCallback(getRelativeX(e.touches[0].clientX));
        }
    }, { passive: false }); // preventDefault()を有効にするため passive: false を明示

    window.addEventListener('touchend', (e) => {
        if (e.target.closest('#gameOverUI')) return;
        onDropCallback();
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