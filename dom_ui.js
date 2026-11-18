/**
 * dom_ui.js
 * HTML要素の更新、スコア表示、および安全なUI制御を行うモジュール
 * 
 * GRAVITY規格に準拠し、ネイティブアプリのクラッシュを防ぐため
 * イベントバブリングの遮断（stopPropagation）や、DOMへの安全なアクセスを提供します。
 */

import { JELLY_CONFIG } from '/sobosuba/constants.js';

// DOM要素のキャッシュ
let elScoreDisplay;
let elNextPreview;
let elGameOverUI;
let elFinalScore;
let elWarningOverlay;
let elRetryBtn;

/**
 * UI制御モジュールの初期化
 * @param {Function} onRetryCallback - リトライボタンが押された時に実行されるコールバック関数
 */
export function initUI(onRetryCallback) {
    elScoreDisplay = document.getElementById('scoreDisplay');
    elNextPreview = document.getElementById('nextPreview');
    elGameOverUI = document.getElementById('gameOverUI');
    elFinalScore = document.getElementById('finalScore');
    elWarningOverlay = document.getElementById('warningOverlay');
    elRetryBtn = document.getElementById('retryBtn');

    // =========================================================
    // GRAVITY規格: ボタンタグを避け、<div> + stopPropagation でリトライを実装
    // WebKitの異常ナビゲーション検知による画面クラッシュ（黒画面）を物理的に防ぎます。
    // =========================================================
    if (elRetryBtn) {
        elRetryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onRetryCallback();
        });
        
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
 * 次に落ちてくるゼリーのプレビューUIを更新
 * @param {number} nextValue - 次のゼリーの数字
 */
export function updateNextPreviewUI(nextValue) {
    if (!elNextPreview) return;
    
    const config = JELLY_CONFIG[nextValue];
    if (config) {
        elNextPreview.innerText = nextValue;
        elNextPreview.style.backgroundColor = config.color;
        elNextPreview.style.color = config.text;
    }
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
        elGameOverUI.classList.remove('hidden');
    }
}

/**
 * ゲームオーバー画面の非表示（リトライ時）
 */
export function hideGameOverUI() {
    if (elGameOverUI) {
        elGameOverUI.classList.add('hidden');
    }
}

/**
 * 左右のバンパーが押し込まれた際の赤色警告エフェクトの表示/非表示
 * @param {boolean} isActive - 警告エフェクトを有効にするかどうか
 */
export function setWarningEffect(isActive) {
    if (!elWarningOverlay) return;
    
    if (isActive) {
        elWarningOverlay.style.opacity = '0.2';
    } else {
        elWarningOverlay.style.opacity = '0';
    }
}