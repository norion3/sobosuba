/**
 * floatbar.js
 * @version v8.7 (Plan 2 Adjusted: Earlier Mid/Late Spawn Table Scaling - Phase 2)
 * @changes
 *   - ゼリーの形・動きおよび最大出現数字（16）を維持したまま適当落としでの自動掃除を抑えるため、generateNextValue() のスコア帯および出現確率を補正済み案 2 へ更新（序盤 0〜39 は現行同一、中盤前倒し 40 で 4・160 で 8・450 で 16 解禁、1400〜 で比率段階引き上げ、終盤 3500〜 は 1:12% / 2:20% / 4:26% / 8:23% / 16:19%）
 * 
 * 上部フロートバーのゼリー生成・出現テーブル・左右2点クリアランス検知スポーナー・
 * セーフティスポーンおよび上枠スポーナーゲージ進捗管理を担うモジュール
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, CONTAINER, FLOAT_BAR } from '/sobosuba/constants.js?v=7';
import {
    createSoftBodyJelly,
    getSoftBodyCentroid,
    getSoftBodyHalfExtents,
    getCapsuleHalfExtentsForValue
} from '/sobosuba/softbody.js?v=7';

// ==========================================
// ゼロアロケーション（毎フレームGC負荷削減）用事前確保バッファ ＆ 状態フラグ
// ==========================================
const floatingJelliesBuffer = [];
const barAreaJelliesBuffer = [];
const barAreaEntryPool = [];

// ゲーム開始直後の初回補充（プレイヤー未操作時の端同数字自動合体回避）フラグ
let isInitialRefillPending = false;

/**
 * 一体外枠フレーム（FRAME_WIDTH）およびバンパー面基準（FLOAT_BAR.PADDING_X）と同期した
 * 上段フロートバーの安全な左右余白（px）を返す
 * @returns {number}
 */
function getSafeBarPaddingX() {
    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    return Math.max(frameW + 4, FLOAT_BAR.PADDING_X || 26);
}

// ==========================================
// 出現テーブル（本家スコア帯準拠・補正済み案2 中終盤前倒し段階拡張）
// ==========================================
/**
 * 現在のスコア進行に応じて、次に上段フロートバーへ供給するゼリーの数値を抽選する
 * @param {number} score - 現在のスコア
 * @returns {number} 出現するゼリーの数値（1, 2, 4, 8, 16）
 */
export function generateNextValue(score = 0) {
    const rand = Math.random();
    const s = Number(score) || 0;

    // 補正済み案2：最大出現数字16を維持し、4/8/16の解禁と比率を前倒しして適当落とし耐性を適正化
    if (s >= 3500) {
        if (rand > 0.81) return 16; // 19%
        if (rand > 0.58) return 8;  // 23%
        if (rand > 0.32) return 4;  // 26%
        if (rand > 0.12) return 2;  // 20%
        return 1;                   // 12%
    }
    if (s >= 1400) {
        if (rand > 0.85) return 16; // 15%
        if (rand > 0.65) return 8;  // 20%
        if (rand > 0.40) return 4;  // 25%
        if (rand > 0.17) return 2;  // 23%
        return 1;                   // 17%
    }
    if (s >= 450) {
        if (rand > 0.90) return 16; // 10%
        if (rand > 0.75) return 8;  // 15%
        if (rand > 0.51) return 4;  // 24%
        if (rand > 0.24) return 2;  // 27%
        return 1;                   // 24%
    }
    if (s >= 160) {
        if (rand > 0.85) return 8;  // 15%
        if (rand > 0.62) return 4;  // 23%
        if (rand > 0.30) return 2;  // 32%
        return 1;                   // 30%
    }
    if (s >= 40) {
        if (rand > 0.75) return 4;  // 25%
        if (rand > 0.35) return 2;  // 40%
        return 1;                   // 35%
    }
    return rand > 0.45 ? 2 : 1;     // 序盤（0〜39）：2(55%) / 1(45%)
}

// ==========================================
// 上段フロートバー状態取得ヘルパー
// ==========================================
/**
 * 現在上部フロートバー上に浮いている全ゼリーを取得する（中空ビーズリング対応・事前確保バッファ再利用）
 * @param {Matter.World} world - Matter.jsの物理世界
 * @returns {Array<Matter.Composite>}
 */
export function getFloatingJellies(world) {
    floatingJelliesBuffer.length = 0;
    if (!world) return floatingJelliesBuffer;
    const composites = world.composites || Matter.Composite.allComposites(world);
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp &&
            comp.label === 'jelly_composite' &&
            comp.isFloating &&
            !comp.isMerging &&
            comp.particles &&
            comp.particles.length > 0) {
            floatingJelliesBuffer.push(comp);
        }
    }
    return floatingJelliesBuffer;
}

/**
 * 現在2.5D上段飛び越えホップ滞空中のゼリー数を取得する
 * @param {Matter.World} world - Matter.jsの物理世界
 * @returns {number}
 */
export function getBarHoppingCount(world) {
    if (!world) return 0;
    const composites = world.composites || Matter.Composite.allComposites(world);
    let count = 0;
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp &&
            comp.label === 'jelly_composite' &&
            comp.isBarHopping &&
            !comp.isMerging) {
            count++;
        }
    }
    return count;
}

/**
 * スポーナーのクリアランス検知および重なり爆発防止のため、バー領域に存在する全ゼリーを
 * 横長カプセル実幅・実高付きで取得する（事前確保バッファ＆プール再利用）
 * @param {Matter.World} world
 * @param {number} newHalfHeight - 出現予定ゼリーの半高
 * @returns {Array<{ comp: Matter.Composite, cx: number, cy: number, halfWidth: number, halfHeight: number }>}
 */
function getBarAreaJellies(world, newHalfHeight) {
    barAreaJelliesBuffer.length = 0;
    if (!world) return barAreaJelliesBuffer;
    const composites = world.composites || Matter.Composite.allComposites(world);
    let poolIndex = 0;

    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (!comp || comp.label !== 'jelly_composite' || !comp.particles || comp.particles.length === 0) {
            continue;
        }
        const centroid = getSoftBodyCentroid(comp);
        if (!centroid) continue;

        const ext = getSoftBodyHalfExtents(comp);
        const dy = Math.abs(centroid.y - FLOAT_BAR.Y);
        if (comp.isFloating || comp.isBarHopping || dy < (ext.halfHeight + newHalfHeight + 14)) {
            let entry = barAreaEntryPool[poolIndex];
            if (!entry) {
                entry = { comp: null, cx: 0, cy: 0, halfWidth: 0, halfHeight: 0 };
                barAreaEntryPool.push(entry);
            }
            entry.comp = comp;
            entry.cx = centroid.x;
            entry.cy = centroid.y;
            entry.halfWidth = ext.halfWidth;
            entry.halfHeight = ext.halfHeight;
            barAreaJelliesBuffer.push(entry);
            poolIndex++;
        }
    }

    // 破棄済みゼリーへの強参照残留を防ぐため、今回未使用のプール要素参照をクリア
    for (let i = poolIndex; i < barAreaEntryPool.length; i++) {
        barAreaEntryPool[i].comp = null;
    }

    return barAreaJelliesBuffer;
}

/**
 * 盤面下段またはホップ中にゼリーが1体以上存在するか（プレイヤーが発射操作済みか）を判定する
 * @param {Matter.World} world
 * @returns {boolean}
 */
function hasAnyNonFloatingJelly(world) {
    if (!world) return false;
    const composites = world.composites || Matter.Composite.allComposites(world);
    for (let i = 0; i < composites.length; i++) {
        const comp = composites[i];
        if (comp && comp.label === 'jelly_composite' && !comp.isFloating) {
            return true;
        }
    }
    return false;
}

/**
 * 出現端（左端／右端）に最も近い待機ゼリーの数値（jellyValue）を取得する
 * @param {Array<Matter.Composite>} floating - 現在の待機ゼリー配列
 * @param {string} side - 'left' | 'right'
 * @returns {number|null}
 */
function getEdgeFloatingValue(floating, side) {
    if (!floating || floating.length === 0) return null;
    let edgeComp = null;
    let edgeX = (side === 'left') ? Infinity : -Infinity;

    for (let i = 0; i < floating.length; i++) {
        const comp = floating[i];
        const centroid = comp.centroid || getSoftBodyCentroid(comp);
        if (!centroid) continue;
        if (side === 'left') {
            if (centroid.x < edgeX) {
                edgeX = centroid.x;
                edgeComp = comp;
            }
        } else {
            if (centroid.x > edgeX) {
                edgeX = centroid.x;
                edgeComp = comp;
            }
        }
    }

    return edgeComp ? edgeComp.jellyValue : null;
}

/**
 * 指定された出現X座標における周囲ゼリーとの最小クリアランス（横長カプセル外縁同士の空き距離）を算出する
 * @param {number} spawnX - 候補となる出現中心X座標
 * @param {number} newHalfW - 出現予定ゼリーの横長カプセル半幅
 * @param {number} newHalfH - 出現予定ゼリーの横長カプセル半高
 * @param {Array} barAreaJellies - バー領域に存在するゼリー一覧
 * @returns {number} 最小クリアランス（px、負値は重なりを意味する）
 */
function calcSpawnClearance(spawnX, newHalfW, newHalfH, barAreaJellies) {
    const padX = getSafeBarPaddingX();
    const minX = padX + newHalfW;
    const maxX = GAME_WIDTH - padX - newHalfW;
    if (spawnX < minX - 1 || spawnX > maxX + 1) return -Infinity;

    let minClearance = Infinity;
    for (let i = 0; i < barAreaJellies.length; i++) {
        const other = barAreaJellies[i];
        const dx = Math.abs(spawnX - other.cx);
        const dy = Math.abs(FLOAT_BAR.Y - other.cy);

        // 横長カプセル同士の外縁分離距離（同一高度では水平方向の純粋な空き距離になる）
        const horizGap = dx - (newHalfW + other.halfWidth);
        const vertGap = dy - (newHalfH + other.halfHeight);
        const clearance = Math.max(horizGap, vertGap);

        if (clearance < minClearance) {
            minClearance = clearance;
        }
    }

    return minClearance;
}

/**
 * スポーナーの空き距離・供給ディレイ・バー上限から、上枠黒ゲージの進捗率（0.0〜1.0）を算出する
 * @param {number} clearance - 算出された最小クリアランス（px）
 * @param {number} requiredMargin - 出現に必要なクリアランス閾値（px）
 * @param {number} newHalfW - 出現予定ゼリーの半幅（px）
 * @param {number} delayRatio - 供給ディレイの経過比率（0.0〜1.0）
 * @param {boolean} isAtCapacity - 上段保持上限（FLOAT_BAR.MAX_COUNT）に達しているか
 * @returns {number} ゲージ進捗率（0.0〜1.0）
 */
function computeSpawnerGaugeRatio(clearance, requiredMargin, newHalfW, delayRatio, isAtCapacity) {
    if (!isFinite(clearance)) {
        // 周囲にゼリーが一切いない（Infinity）場合は空間100%空き、範囲外（-Infinity）は0%
        if (clearance === Infinity) {
            return isAtCapacity ? Math.min(0.88, delayRatio) : delayRatio;
        }
        return 0;
    }

    const span = Math.max(24, newHalfW * 2);
    const spaceRatio = Math.max(0, Math.min(1, (clearance + span) / (requiredMargin + span)));
    const combined = spaceRatio * delayRatio;

    if (isAtCapacity) {
        return Math.min(0.88, combined);
    }
    return Math.max(0, Math.min(1, combined));
}

/**
 * gameState.spawnerGauges へ左右ゲージ進捗率をインプレース反映して返す
 * @param {Object} gameState
 * @param {number} leftRatio
 * @param {number} rightRatio
 * @returns {{ leftGaugeRatio: number, rightGaugeRatio: number }}
 */
function writeGaugeState(gameState, leftRatio, rightRatio) {
    const clampedL = Math.max(0, Math.min(1, leftRatio || 0));
    const clampedR = Math.max(0, Math.min(1, rightRatio || 0));

    if (gameState) {
        if (!gameState.spawnerGauges) {
            gameState.spawnerGauges = { leftGaugeRatio: clampedL, rightGaugeRatio: clampedR };
        } else {
            gameState.spawnerGauges.leftGaugeRatio = clampedL;
            gameState.spawnerGauges.rightGaugeRatio = clampedR;
        }
    }

    return {
        leftGaugeRatio: clampedL,
        rightGaugeRatio: clampedR
    };
}

// ==========================================
// 初期配置 ＆ 毎フレーム補充メンテナンス
// ==========================================
/**
 * ゲーム開始時に上部フロートバーへ初期ゼリーを内壁・バンパー面基準の横長カプセル実幅間隔で配置する
 * 開始直後の意図せぬ自動合体を防ぐため、隣接する数字が重複しないように生成する
 * @param {Matter.World} world - Matter.jsの物理世界
 * @param {Object} gameState - ゲーム状態オブジェクト
 */
export function initFloatBar(world, gameState) {
    if (!world) return;

    // 開始直後の初回補充で端のゼリーと同数字が供給されて自動合体するケースを回避するためのフラグを初期化
    isInitialRefillPending = true;

    const padX = getSafeBarPaddingX();
    const score = gameState ? gameState.score : 0;
    const count = Math.min(4, FLOAT_BAR.MAX_COUNT || 5);
    const values = [];
    const halfWidths = [];
    let sumWidths = 0;

    for (let i = 0; i < count; i++) {
        let val = generateNextValue(score);
        // 直前のゼリーと同じ数字になった場合は別値へ切り替えて開始直後の勝手な合体を防止
        if (i > 0 && val === values[i - 1]) {
            val = (val === 1) ? 2 : 1;
        }
        const capExt = getCapsuleHalfExtentsForValue(val);
        values.push(val);
        halfWidths.push(capExt.halfWidth);
        sumWidths += capExt.halfWidth * 2;
    }

    const gap = 8;
    const usableWidth = GAME_WIDTH - padX * 2;
    const totalWidth = sumWidths + (count - 1) * gap;
    const scaleRatio = totalWidth > usableWidth ? (usableWidth / totalWidth) : 1;
    const actualTotalWidth = totalWidth * scaleRatio;

    let cursorX = (GAME_WIDTH - actualTotalWidth) / 2;

    for (let i = 0; i < count; i++) {
        const hw = halfWidths[i];
        const minX = padX + hw;
        const maxX = GAME_WIDTH - padX - hw;
        const rawX = cursorX + hw * scaleRatio;
        const clampedX = (minX <= maxX) ? Math.max(minX, Math.min(maxX, rawX)) : (GAME_WIDTH / 2);

        // 初期スポーンは上段横長カプセル・未合体（hasMerged = false）として生成
        const comp = createSoftBodyJelly(clampedX, FLOAT_BAR.Y, values[i], null, true, false);
        Matter.Composite.add(world, comp);

        cursorX += (hw * 2 + gap) * scaleRatio;
    }

    writeGaugeState(gameState, 0, 0);
}

/**
 * 本家準拠：左右2箇所のスポーナーが内壁・バンパー面基準の横長実幅ベースで空き距離（クリアランス）を検知して補充し、
 * 両端閉塞かつバーが空の状態が続いた場合はセーフティスポーンで詰みを防ぐ。
 * あわせて上枠描画用の左右スポーナー黒ゲージ進捗率（leftGaugeRatio / rightGaugeRatio）を算出・返却する。
 * @param {Matter.World} world - Matter.jsの物理世界
 * @param {Object} gameState - ゲーム状態オブジェクト
 * @returns {{ leftGaugeRatio: number, rightGaugeRatio: number }}
 */
export function maintainFloatBar(world, gameState) {
    if (!world || !gameState || gameState.isGameOver) {
        return writeGaugeState(gameState, 0, 0);
    }

    const now = Date.now();
    const padX = getSafeBarPaddingX();
    const floating = getFloatingJellies(world);
    const hoppingCount = getBarHoppingCount(world);
    const barOwnedCount = floating.length + hoppingCount;

    // プレイヤーが1発でも発射・ホップ済み、またはスコア進行済みなら初回補充回避フラグを解除
    if (isInitialRefillPending &&
        ((gameState.score || 0) > 0 || hoppingCount > 0 || floating.length < 4 || hasAnyNonFloatingJelly(world))) {
        isInitialRefillPending = false;
    }

    // バーが空になってからの経過時間を追跡（ホップ滞空中は空とみなさない）
    if (barOwnedCount === 0) {
        if (gameState.barEmptySince === 0) {
            gameState.barEmptySince = now;
        }
    } else {
        gameState.barEmptySince = 0;
    }

    // 次に補充する数値が未決定なら抽選して保持（空き待ち中の値ブレ・ゲージ揺れを防止）
    if (gameState.pendingSpawnValue === null || gameState.pendingSpawnValue === undefined) {
        gameState.pendingSpawnValue = generateNextValue(gameState.score);
    }

    const val = gameState.pendingSpawnValue;
    const capExt = getCapsuleHalfExtentsForValue(val);
    const newHalfW = capExt.halfWidth;
    const newHalfH = capExt.halfHeight;
    const clearanceMargin = FLOAT_BAR.SPAWN_CLEARANCE_MARGIN || 6;
    const entrySpeed = FLOAT_BAR.SPAWN_ENTRY_VELOCITY || 0.55;
    const spawnDelayMs = Math.max(1, FLOAT_BAR.SPAWN_DELAY_MS || 260);
    const elapsedSinceLastSpawn = Math.max(0, now - (gameState.lastFloatSpawnTime || 0));
    const delayRatio = Math.min(1, elapsedSinceLastSpawn / spawnDelayMs);
    const isAtCapacity = barOwnedCount >= (FLOAT_BAR.MAX_COUNT || 5);

    const barAreaJellies = getBarAreaJellies(world, newHalfH);

    // 左右2点スポーナーの基準X座標（内壁8px＋バンパー面回避の safePadX と横長実半幅を考慮）
    const leftSpawnX = Math.max(FLOAT_BAR.LEFT_SPAWN_X || (padX + newHalfW), padX + newHalfW);
    const rightSpawnX = Math.min(FLOAT_BAR.RIGHT_SPAWN_X || (GAME_WIDTH - padX - newHalfW), GAME_WIDTH - padX - newHalfW);

    const leftClearance = calcSpawnClearance(leftSpawnX, newHalfW, newHalfH, barAreaJellies);
    const rightClearance = calcSpawnClearance(rightSpawnX, newHalfW, newHalfH, barAreaJellies);

    // 上枠の左右2本スポーナー黒ゲージ進捗率を算出
    let leftGaugeRatio = computeSpawnerGaugeRatio(leftClearance, clearanceMargin, newHalfW, delayRatio, isAtCapacity);
    let rightGaugeRatio = computeSpawnerGaugeRatio(rightClearance, clearanceMargin, newHalfW, delayRatio, isAtCapacity);

    // 上限到達中または供給ディレイ（ゲージの間）未経過時はゲージ更新のみ行って終了
    if (isAtCapacity || elapsedSinceLastSpawn < spawnDelayMs) {
        return writeGaugeState(gameState, leftGaugeRatio, rightGaugeRatio);
    }

    const canSpawnLeft = leftClearance >= clearanceMargin;
    const canSpawnRight = rightClearance >= clearanceMargin;

    let chosenSide = null;
    if (canSpawnLeft && canSpawnRight) {
        // 双方に十分な空きがある場合は、クリアランスに大差がなければ左右交互に送り出す
        if (Math.abs(leftClearance - rightClearance) > 12) {
            chosenSide = leftClearance > rightClearance ? 'left' : 'right';
        } else {
            chosenSide = gameState.lastSpawnSide === 'left' ? 'right' : 'left';
        }
    } else if (canSpawnLeft) {
        chosenSide = 'left';
    } else if (canSpawnRight) {
        chosenSide = 'right';
    }

    if (chosenSide !== null) {
        let spawnVal = val;
        let spawnHalfW = newHalfW;

        // 開始直後の初回補充（プレイヤー未操作状態）で出現端のゼリーと同数字になる場合は別値へ切り替えて自動合体を回避
        if (isInitialRefillPending) {
            const edgeVal = getEdgeFloatingValue(floating, chosenSide);
            if (edgeVal !== null && spawnVal === edgeVal) {
                spawnVal = (spawnVal === 1) ? 2 : 1;
                spawnHalfW = getCapsuleHalfExtentsForValue(spawnVal).halfWidth;
            }
            isInitialRefillPending = false;
        }

        const spawnX = (chosenSide === 'left')
            ? Math.max(FLOAT_BAR.LEFT_SPAWN_X || (padX + spawnHalfW), padX + spawnHalfW)
            : Math.min(FLOAT_BAR.RIGHT_SPAWN_X || (GAME_WIDTH - padX - spawnHalfW), GAME_WIDTH - padX - spawnHalfW);
        const entryVel = {
            x: chosenSide === 'left' ? entrySpeed : -entrySpeed,
            y: 0
        };
        const newComp = createSoftBodyJelly(spawnX, FLOAT_BAR.Y, spawnVal, entryVel, true, false);
        Matter.Composite.add(world, newComp);

        gameState.lastSpawnSide = chosenSide;
        gameState.lastFloatSpawnTime = now;
        gameState.pendingSpawnValue = null;
        gameState.barEmptySince = 0;

        // 供給直後は該当側ゲージをリセット（次フレームから再び黒が埋まり始める）
        if (chosenSide === 'left') {
            leftGaugeRatio = 0;
        } else {
            rightGaugeRatio = 0;
        }
        return writeGaugeState(gameState, leftGaugeRatio, rightGaugeRatio);
    }

    // ==========================================
    // セーフティスポーン（本家救済仕様）
    // 下の塊で左右両スポーナーが塞がれ、バー上が0個のまま一定時間経過したら強制補充
    // ==========================================
    const safetyDelay = FLOAT_BAR.SAFETY_SPAWN_DELAY_MS || 1500;
    if (barOwnedCount === 0 && gameState.barEmptySince > 0 && (now - gameState.barEmptySince) >= safetyDelay) {
        const minX = padX + newHalfW;
        const maxX = GAME_WIDTH - padX - newHalfW;
        let bestX = GAME_WIDTH / 2;
        let bestClearance = -Infinity;
        const samples = 9;

        if (minX <= maxX) {
            for (let s = 0; s < samples; s++) {
                const candX = minX + ((maxX - minX) * s) / (samples - 1);
                const c = calcSpawnClearance(candX, newHalfW, newHalfH, barAreaJellies);
                if (c > bestClearance) {
                    bestClearance = c;
                    bestX = candX;
                }
            }
        }

        const safeComp = createSoftBodyJelly(bestX, FLOAT_BAR.Y, val, { x: 0, y: 0 }, true, false);
        Matter.Composite.add(world, safeComp);

        isInitialRefillPending = false;
        gameState.lastFloatSpawnTime = now;
        gameState.pendingSpawnValue = null;
        gameState.barEmptySince = 0;

        return writeGaugeState(gameState, 0, 0);
    }

    return writeGaugeState(gameState, leftGaugeRatio, rightGaugeRatio);
}