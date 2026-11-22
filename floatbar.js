/**
 * floatbar.js
 * @version v8.11 (Spawn Edge Margin Optimization & Make-Room Drift for Split-Gap Bar Refill - Phase 1)
 * @changes
 *   - 待機ゼリーの定常余白（PADDING_X: 26）を維持したまま、左右スポーナー専用の端マージン getSafeSpawnPaddingX()（frameW + 6 = 14px）を導入し、スポーナー基準座標および calcSpawnClearance() の壁チェックを統一
 *   - バー上に空きがあるのに中央寄せで左右に分断されて補充が止まる現象を解消するため、道開けスライド（Make-Room Drift）を追加（performance.now() 60Hz 正規化・実効幅総幅チェック・物理接触余裕マージン・バー上 isMerging 停止ガード・退避先下段ゼリー境界チェック・!gameState.isDragging ガード・activeDriftSide 一方向ロック・事前確保 tempDriftVel・initFloatBar() での状態リセット）
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
const fallbackGaugeState = { leftGaugeRatio: 0, rightGaugeRatio: 0 };
const tempDriftVel = { x: 0, y: 0 };

// ゲーム開始直後の初回補充（プレイヤー未操作時の端同数字自動合体回避）フラグ
let isInitialRefillPending = false;

// 道開けスライド（Make-Room Drift）の一方向ロックおよび時間正規化状態
let activeDriftSide = null;
let lastDriftTimeMs = 0;

/**
 * 一体外枠フレーム（FRAME_WIDTH）およびバンパー面基準（FLOAT_BAR.PADDING_X）と同期した
 * 上段フロートバーの安全な左右余白（px）を返す
 * @returns {number}
 */
function getSafeBarPaddingX() {
    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    return Math.max(frameW + 4, FLOAT_BAR.PADDING_X || 26);
}

/**
 * 左右スポーナー専用の安全な端マージン（内壁 + 6px = 14px）を返す
 * （待機ゼリーの定常保持余白 getSafeBarPaddingX() は変えず、左右出現可能幅のみを適正化）
 * @returns {number}
 */
function getSafeSpawnPaddingX() {
    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    return frameW + 6;
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
    const spawnPadX = getSafeSpawnPaddingX();
    const minX = spawnPadX + newHalfW;
    const maxX = GAME_WIDTH - spawnPadX - newHalfW;
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
 * gameState.spawnerGauges へ左右ゲージ進捗率をインプレース反映して返す（ゼロアロケーション）
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
        return gameState.spawnerGauges;
    }

    fallbackGaugeState.leftGaugeRatio = clampedL;
    fallbackGaugeState.rightGaugeRatio = clampedR;
    return fallbackGaugeState;
}

/**
 * 中央寄せで空きスペースが左右に分断されて補充が止まった際、
 * 物理的に収まる場合のみ既存の待機ゼリー群を反対側へ穏やかにスライドさせて道を開ける（Make-Room Drift）
 * （60Hz/120Hz ProMotion 時間正規化・バー上 isMerging 停止・退避先下段ゼリー境界停止・高速移動非減速ガード付き）
 */
function applyMakeRoomDrift(
    floating,
    barAreaJellies,
    gameState,
    leftSpawnX,
    rightSpawnX,
    leftClearance,
    rightClearance,
    newHalfW,
    newHalfH,
    clearanceMargin,
    padX,
    spawnPadX
) {
    const floatingCount = floating.length;
    if (floatingCount === 0 || gameState.isDragging) {
        activeDriftSide = null;
        lastDriftTimeMs = 0;
        return;
    }

    const channelHalfH = FLOAT_BAR.CHANNEL_HALF_HEIGHT || 26;
    const leftSpawnRightEdge = leftSpawnX + newHalfW;
    const rightSpawnLeftEdge = rightSpawnX - newHalfW;

    let sumFloatingWidth = 0;
    let leftFieldOpen = true;
    let rightFieldOpen = true;
    let rightFieldEdge = GAME_WIDTH - padX;
    let leftFieldEdge = padX;

    for (let i = 0; i < barAreaJellies.length; i++) {
        const entry = barAreaJellies[i];
        const comp = entry.comp;
        if (!comp) continue;

        // バー領域で合体吸い付き中（isMerging）のゼリーがある間は総幅ズレ防止のため道開けを停止
        if (comp.isMerging) {
            activeDriftSide = null;
            lastDriftTimeMs = 0;
            return;
        }

        if (comp.isFloating) {
            sumFloatingWidth += entry.halfWidth * 2;
            continue;
        }

        if (comp.isBarHopping) continue;

        // 下段ゼリーによる左右スポーン位置の閉塞判定
        const dyField = Math.abs(FLOAT_BAR.Y - entry.cy);
        const vertGap = dyField - (newHalfH + entry.halfHeight);

        const leftHorizGap = Math.abs(leftSpawnX - entry.cx) - (newHalfW + entry.halfWidth);
        if (Math.max(leftHorizGap, vertGap) < clearanceMargin) {
            leftFieldOpen = false;
        }

        const rightHorizGap = Math.abs(rightSpawnX - entry.cx) - (newHalfW + entry.halfWidth);
        if (Math.max(rightHorizGap, vertGap) < clearanceMargin) {
            rightFieldOpen = false;
        }

        // 退避先のバー高さ帯へ突き出ている下段ゼリーの境界を計測し、押し付けを防止
        if (dyField < (channelHalfH + entry.halfHeight + 2)) {
            if (entry.cx > leftSpawnRightEdge) {
                const candidateRight = entry.cx - entry.halfWidth - 2;
                if (candidateRight < rightFieldEdge) {
                    rightFieldEdge = candidateRight;
                }
            }
            if (entry.cx < rightSpawnLeftEdge) {
                const candidateLeft = entry.cx + entry.halfWidth + 2;
                if (candidateLeft > leftFieldEdge) {
                    leftFieldEdge = candidateLeft;
                }
            }
        }
    }

    const effectiveRightEdge = Math.min(GAME_WIDTH - padX, rightFieldEdge);
    const effectiveLeftEdge = Math.max(padX, leftFieldEdge);

    // 物理接触余裕マージン（(floatingCount - 1) * 4 + 6）を含めた必要総幅で収容可否を判定
    const requiredTotalWidth = sumFloatingWidth + newHalfW * 2 + clearanceMargin + (floatingCount - 1) * 4 + 6;
    const canMakeRoomLeft = leftFieldOpen && requiredTotalWidth <= (effectiveRightEdge - spawnPadX);
    const canMakeRoomRight = rightFieldOpen && requiredTotalWidth <= ((GAME_WIDTH - spawnPadX) - effectiveLeftEdge);

    if (!canMakeRoomLeft && !canMakeRoomRight) {
        activeDriftSide = null;
        lastDriftTimeMs = 0;
        return;
    }

    // 一方向ロック（往復バタつきゼロ）：既存方向が有効なら維持、無効なら空きが広い側または交互側を選択
    if (activeDriftSide === 'left' && !canMakeRoomLeft) {
        activeDriftSide = null;
    } else if (activeDriftSide === 'right' && !canMakeRoomRight) {
        activeDriftSide = null;
    }

    if (activeDriftSide === null) {
        if (canMakeRoomLeft && canMakeRoomRight) {
            if (Math.abs(leftClearance - rightClearance) > 12) {
                activeDriftSide = leftClearance > rightClearance ? 'left' : 'right';
            } else {
                activeDriftSide = gameState.lastSpawnSide === 'left' ? 'right' : 'left';
            }
        } else {
            activeDriftSide = canMakeRoomLeft ? 'left' : 'right';
        }
    }

    // performance.now() による 60Hz / 120Hz ProMotion 時間正規化（上限 33.333ms クランプ）
    const nowPerf = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
    const dtMs = (lastDriftTimeMs > 0)
        ? Math.max(0, Math.min(33.333, nowPerf - lastDriftTimeMs))
        : (1000 / 60);
    lastDriftTimeMs = nowPerf;
    const stepScale = dtMs / (1000 / 60);

    const driftDir = (activeDriftSide === 'left') ? 1 : -1;
    const driftAccel = 0.075 * stepScale;
    const maxDriftSpeed = 1.35;

    for (let i = 0; i < floatingCount; i++) {
        const comp = floating[i];
        if (!comp || !comp.particles || comp.particles.length === 0) continue;

        const centroid = comp.centroid || getSoftBodyCentroid(comp);
        if (!centroid) continue;

        const ext = getSoftBodyHalfExtents(comp);
        const compHalfW = ext.halfWidth || comp.capsuleHalfWidth || comp.targetRadius || 25.5;

        // 反対端または下段ゼリー境界へ到達済みのゼリーは加速対象から除外
        if (driftDir > 0) {
            if (centroid.x + compHalfW >= effectiveRightEdge - 1) continue;
        } else {
            if (centroid.x - compHalfW <= effectiveLeftEdge + 1) continue;
        }

        const pts = comp.particles;
        for (let j = 0; j < pts.length; j++) {
            const p = pts[j];
            const vx = p.velocity.x;
            // 既に同方向へ maxDriftSpeed 以上で移動中の場合は逆ブレーキを掛けない
            if (driftDir > 0) {
                if (vx < maxDriftSpeed) {
                    tempDriftVel.x = Math.min(maxDriftSpeed, vx + driftAccel);
                    tempDriftVel.y = p.velocity.y;
                    Matter.Body.setVelocity(p, tempDriftVel);
                }
            } else {
                if (vx > -maxDriftSpeed) {
                    tempDriftVel.x = Math.max(-maxDriftSpeed, vx - driftAccel);
                    tempDriftVel.y = p.velocity.y;
                    Matter.Body.setVelocity(p, tempDriftVel);
                }
            }
        }
    }
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

    // 開始直後の初回補充回避フラグおよび道開けスライド状態を初期化
    isInitialRefillPending = true;
    activeDriftSide = null;
    lastDriftTimeMs = 0;

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
 * 本家準拠：左右2箇所のスポーナーが内壁基準の横長実幅ベースで空き距離（クリアランス）を検知して補充し、
 * 中央寄せによる空き分断時は穏やかな道開けスライドで補充を促す。
 * 両端閉塞かつバーが空の状態が続いた場合はセーフティスポーンで詰みを防ぐ。
 * あわせて上枠描画用の左右スポーナー黒ゲージ進捗率（leftGaugeRatio / rightGaugeRatio）を算出・返却する。
 * @param {Matter.World} world - Matter.jsの物理世界
 * @param {Object} gameState - ゲーム状態オブジェクト
 * @returns {{ leftGaugeRatio: number, rightGaugeRatio: number }}
 */
export function maintainFloatBar(world, gameState) {
    if (!world || !gameState || gameState.isGameOver) {
        activeDriftSide = null;
        lastDriftTimeMs = 0;
        return writeGaugeState(gameState, 0, 0);
    }

    const now = Date.now();
    const padX = getSafeBarPaddingX();
    const spawnPadX = getSafeSpawnPaddingX();
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

    // 左右2点スポーナーの基準X座標（スポーン専用端マージン spawnPadX = 14px と横長実半幅基準）
    const leftSpawnX = spawnPadX + newHalfW;
    const rightSpawnX = GAME_WIDTH - spawnPadX - newHalfW;

    const leftClearance = calcSpawnClearance(leftSpawnX, newHalfW, newHalfH, barAreaJellies);
    const rightClearance = calcSpawnClearance(rightSpawnX, newHalfW, newHalfH, barAreaJellies);

    // 上枠の左右2本スポーナー黒ゲージ進捗率を算出
    let leftGaugeRatio = computeSpawnerGaugeRatio(leftClearance, clearanceMargin, newHalfW, delayRatio, isAtCapacity);
    let rightGaugeRatio = computeSpawnerGaugeRatio(rightClearance, clearanceMargin, newHalfW, delayRatio, isAtCapacity);

    // 上限到達中または供給ディレイ（ゲージの間）未経過時は道開けを解除しゲージ更新のみ行って終了
    if (isAtCapacity || elapsedSinceLastSpawn < spawnDelayMs) {
        activeDriftSide = null;
        lastDriftTimeMs = 0;
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
            ? (spawnPadX + spawnHalfW)
            : (GAME_WIDTH - spawnPadX - spawnHalfW);
        const entryVel = {
            x: chosenSide === 'left' ? entrySpeed : -entrySpeed,
            y: 0
        };
        const newComp = createSoftBodyJelly(spawnX, FLOAT_BAR.Y, spawnVal, entryVel, true, false);
        Matter.Composite.add(world, newComp);

        activeDriftSide = null;
        lastDriftTimeMs = 0;
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

    // 左右どちらも空き不足だが待機ゼリーがありホップ中でない場合、収容可能なら穏やかな道開けスライドを実行
    if (floating.length > 0 && hoppingCount === 0) {
        applyMakeRoomDrift(
            floating,
            barAreaJellies,
            gameState,
            leftSpawnX,
            rightSpawnX,
            leftClearance,
            rightClearance,
            newHalfW,
            newHalfH,
            clearanceMargin,
            padX,
            spawnPadX
        );
    } else {
        activeDriftSide = null;
        lastDriftTimeMs = 0;
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

        // 高積み上げ時の重なり暴発を防ぐため、出現候補 X 幅と重なる下段ゼリー最上端を避ける安全高度へ補正
        const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
        const minSafeY = topBarH + newHalfH + 2;
        let safeSpawnY = FLOAT_BAR.Y;
        const composites = world.composites || Matter.Composite.allComposites(world);
        let minFieldTopY = Infinity;

        for (let i = 0; i < composites.length; i++) {
            const other = composites[i];
            if (!other || other.label !== 'jelly_composite' ||
                other.isFloating || other.isBarHopping || !other.aabb) {
                continue;
            }
            const aB = other.aabb;
            const rB = other.particleRadius || 4;
            if (!(bestX + newHalfW < aB.minX - rB || bestX - newHalfW > aB.maxX + rB)) {
                const topY = aB.minY - rB;
                if (topY < minFieldTopY) {
                    minFieldTopY = topY;
                }
            }
        }
        if (isFinite(minFieldTopY)) {
            safeSpawnY = Math.max(minSafeY, Math.min(FLOAT_BAR.Y, minFieldTopY - newHalfH - 2));
        }

        const safeComp = createSoftBodyJelly(bestX, safeSpawnY, val, { x: 0, y: 0 }, true, false);
        Matter.Composite.add(world, safeComp);

        activeDriftSide = null;
        lastDriftTimeMs = 0;
        isInitialRefillPending = false;
        gameState.lastFloatSpawnTime = now;
        gameState.pendingSpawnValue = null;
        gameState.barEmptySince = 0;

        return writeGaugeState(gameState, 0, 0);
    }

    return writeGaugeState(gameState, leftGaugeRatio, rightGaugeRatio);
}