/**
 * physics.js
 * @version v6.0 (Fluid Physics, Controls, Bumper & Audio Overhaul Step 4)
 * @changes
 *   - 一体外枠フレーム（CONTAINER.FRAME_WIDTH: 8 / CONTAINER.TOP_BAR_HEIGHT: 12）の内壁基準へ、壁・天井・床・底面45度スロープ剛体・バンパー休止位置（x=17 / 403）・バネ支点（自然長20px→最大押込時5px反転なし）・clampPointToContainer() を数式0.000px誤差で完全同期
 *   - サイド判定ボタン（左右バンパー）の物理剛体へ角丸面取り（chamfer: { radius: BUMPER.CHAMFER_RADIUS }）と最適密度（PHYSICS.BUMPER_DENSITY: 0.035）を適用し、上下端での引っ掛かり防止と自然な押し込み手応えを実現
 *   - 下敷き小塊の微振動を物理収束側からも抑えるため、Matter.js の反復回数（engine.positionIterations = 8 / engine.velocityIterations = 6）を強化
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスを /sobosuba/constants.js?v=6 へ統一
 * 
 * Matter.jsを用いた物理世界の初期化、壁の生成、サブステップ駆動、および
 * ゲームオーバー条件となる「左右のサイド判定ボタン（バンパースイッチ）」を構築・制御するモジュール
 * 
 * GRAVITY起動エラーを根絶するため、HTMLの<script>タグ依存を排除し、
 * CDN（esm.sh）経由でMatter.jsを直接ESModuleとしてインポートします。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, WALL_THICKNESS, BUMPER, PHYSICS, CONTAINER, COLLISION_CATEGORY } from '/sobosuba/constants.js?v=6';

// Matter.jsのモジュールエイリアス
const Engine = Matter.Engine;
const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

// 壁・天井・床・スロープと衝突させるゼリーカテゴリの合成マスク
const ALL_JELLY_MASK =
    COLLISION_CATEGORY.FIELD_JELLY |
    COLLISION_CATEGORY.BAR_FLOATING |
    COLLISION_CATEGORY.BAR_HOPPING;

// 物理世界の状態を保持
export let engine;
export let world;
export let leftBumper;
export let rightBumper;

// バンパーの基準（休止）位置および同時押し込み継続時間
let restXLeft;
let restXRight;
let bumperY;
let bothPressedDurationMs = 0;

/**
 * 座標 (x, y) を一体外枠フレームの内壁（FRAME_WIDTH / TOP_BAR_HEIGHT）および
 * 底面左右の45度角カットスロープの内側へ安全にクランプする
 * （softbody.js / overlap_solver.js の修復・非侵入排斥ソルバーによる壁・スロープ貫通を防止）
 * @param {number} x - 判定対象のX座標
 * @param {number} y - 判定対象のY座標
 * @param {number} margin - 内壁・スロープ面から確保する内側マージン（ビーズ半径など）
 * @param {{ x: number, y: number }|null} out - GC負荷削減用の出力先オブジェクト（省略時は新規作成）
 * @returns {{ x: number, y: number }} クランプ後の座標
 */
export function clampPointToContainer(x, y, margin = 0, out = null) {
    const safeMargin = Math.max(0, margin);
    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;

    const innerLeft = frameW;
    const innerRight = GAME_WIDTH - frameW;
    const innerTop = topBarH;
    const innerBottom = GAME_HEIGHT - frameW;

    const minX = innerLeft + safeMargin;
    const maxX = innerRight - safeMargin;
    const minY = innerTop + safeMargin;
    const maxY = innerBottom - safeMargin;

    let cx = Math.max(minX, Math.min(maxX, x));
    let cy = Math.max(minY, Math.min(maxY, y));

    const cut = CONTAINER.CORNER_CUT_SIZE;
    if (cut > 0) {
        const invSqrt2 = Math.SQRT1_2;

        // 左下45度スロープ（内壁基準）: 頂点 (innerLeft, innerBottom - cut) - (innerLeft + cut, innerBottom)
        // 内側（右上）法線ベクトル = (invSqrt2, -invSqrt2)
        const leftDist = (cx - cy + innerBottom - innerLeft - cut) * invSqrt2;
        if (leftDist < safeMargin) {
            const push = safeMargin - leftDist;
            cx += push * invSqrt2;
            cy -= push * invSqrt2;
        }

        // 右下45度スロープ（内壁基準）: 頂点 (innerRight - cut, innerBottom) - (innerRight, innerBottom - cut)
        // 内側（左上）法線ベクトル = (-invSqrt2, -invSqrt2)
        const rightDist = (innerRight + innerBottom - cut - cx - cy) * invSqrt2;
        if (rightDist < safeMargin) {
            const push = safeMargin - rightDist;
            cx -= push * invSqrt2;
            cy -= push * invSqrt2;
        }

        // スロープ押し戻し後の最終的な内壁矩形内安全クランプ
        cx = Math.max(minX, Math.min(maxX, cx));
        cy = Math.max(minY, Math.min(maxY, cy));
    }

    if (out) {
        out.x = cx;
        out.y = cy;
        return out;
    }
    return { x: cx, y: cy };
}

/**
 * 物理エンジンの初期化と内壁基準の壁・45度スロープ・角丸サイド判定ボタン（バンパー）の生成
 */
export function initPhysics() {
    // 既存のエンジンがあればクリア
    if (engine) {
        Matter.Engine.clear(engine);
    }

    engine = Engine.create();
    // 圧迫下での微小振動を抑え物理収束性を高める反復回数強化
    engine.positionIterations = 8;
    engine.velocityIterations = 6;

    world = engine.world;
    bothPressedDurationMs = 0;

    // ゼリーが積み上がって横圧力を生むように重力を設定
    engine.gravity.y = PHYSICS.GRAVITY_Y;

    // 一体外枠フレームの内壁座標を算出（physics / clamp / render で 0.000px 誤差同期）
    const frameW = (CONTAINER.FRAME_WIDTH !== undefined) ? CONTAINER.FRAME_WIDTH : 8;
    const topBarH = (CONTAINER.TOP_BAR_HEIGHT !== undefined) ? CONTAINER.TOP_BAR_HEIGHT : 12;
    const innerLeft = frameW;
    const innerRight = GAME_WIDTH - frameW;
    const innerTop = topBarH;
    const innerBottom = GAME_HEIGHT - frameW;

    // --- 床・天井・左右内壁・底面角カットスロープの生成（極低摩擦化） ---
    const wallOptions = {
        isStatic: true,
        render: { visible: false },
        friction: PHYSICS.FRICTION,
        frictionStatic: PHYSICS.FRICTION_STATIC,
        restitution: PHYSICS.RESTITUTION,
        // 全カテゴリのゼリー（下段・上段待機・上段ホップ中）と衝突し、バンパーとは衝突しないフィルタ設定
        collisionFilter: {
            category: COLLISION_CATEGORY.WALL,
            mask: ALL_JELLY_MASK
        }
    };

    // 上段飛び越えホップ時に天井へ軽く当たっても張り付かず滑らかに反射する天井クッション設定
    const ceilingOptions = {
        ...wallOptions,
        friction: 0.01,
        frictionStatic: 0.01,
        restitution: 0.45,
        label: 'ceiling'
    };

    // 容器底面の左右45度角カット（内壁基準スロープ壁）の座標計算
    const cut = CONTAINER.CORNER_CUT_SIZE;
    const slopeLength = cut * Math.SQRT2 * 1.6;
    const halfThickDiag = (WALL_THICKNESS / 2) * Math.SQRT1_2;

    const leftSlope = Bodies.rectangle(
        (innerLeft + cut / 2) - halfThickDiag,
        (innerBottom - cut / 2) + halfThickDiag,
        slopeLength,
        WALL_THICKNESS,
        { ...wallOptions, angle: Math.PI / 4, label: 'corner_slope_left' }
    );

    const rightSlope = Bodies.rectangle(
        (innerRight - cut / 2) + halfThickDiag,
        (innerBottom - cut / 2) + halfThickDiag,
        slopeLength,
        WALL_THICKNESS,
        { ...wallOptions, angle: -Math.PI / 4, label: 'corner_slope_right' }
    );

    Composite.add(world, [
        // 天井（内壁上端 y = innerTop に面を一致）
        Bodies.rectangle(GAME_WIDTH / 2, innerTop - WALL_THICKNESS / 2, GAME_WIDTH * 2, WALL_THICKNESS, ceilingOptions),
        // 床（内壁底面 y = innerBottom に面を一致）
        Bodies.rectangle(GAME_WIDTH / 2, innerBottom + WALL_THICKNESS / 2, GAME_WIDTH * 2, WALL_THICKNESS, wallOptions),
        // 左右の内壁（左面 x = innerLeft、右面 x = innerRight に面を一致）
        Bodies.rectangle(innerLeft - WALL_THICKNESS / 2, GAME_HEIGHT / 2, WALL_THICKNESS, GAME_HEIGHT * 2, wallOptions),
        Bodies.rectangle(innerRight + WALL_THICKNESS / 2, GAME_HEIGHT / 2, WALL_THICKNESS, GAME_HEIGHT * 2, wallOptions),
        // 底面の左右45度角カットスロープ壁（内壁基準）
        leftSlope,
        rightSlope
    ]);

    // --- 左右サイド判定ボタン（バンパー）機構の構築 ---
    bumperY = GAME_HEIGHT * BUMPER.Y_RATIO;
    const bumperHeight = GAME_HEIGHT * BUMPER.HEIGHT_RATIO;

    // バンパーの休止X座標（内壁面から内側へ BUMPER.WIDTH 分突出した状態：左 x=17 / 右 x=403）
    restXLeft = innerLeft + (BUMPER.WIDTH / 2);
    restXRight = innerRight - (BUMPER.WIDTH / 2);

    // 上下端でゼリーが引っ掛かりにくい角丸面取り半径
    const chamferRadius = Math.max(0, Math.min(BUMPER.CHAMFER_RADIUS || 7, (BUMPER.WIDTH / 2) - 0.5));

    const bumperOptions = {
        isStatic: false, // バネで動くようにスライドアクションを許可
        friction: PHYSICS.FRICTION,
        frictionStatic: PHYSICS.FRICTION_STATIC,
        restitution: 0.15,
        density: PHYSICS.BUMPER_DENSITY || 0.035,
        chamfer: { radius: chamferRadius },
        label: 'bumper',
        // 下段の FIELD_JELLY のみと衝突し、壁や上段待機・ホップ中ゼリーとは干渉しないフィルタ設定
        collisionFilter: {
            category: COLLISION_CATEGORY.BUMPER,
            mask: COLLISION_CATEGORY.FIELD_JELLY
        }
    };

    // 内壁基準の角丸左バンパー・右バンパー
    leftBumper = Bodies.rectangle(restXLeft, bumperY, BUMPER.WIDTH, bumperHeight, bumperOptions);
    rightBumper = Bodies.rectangle(restXRight, bumperY, BUMPER.WIDTH, bumperHeight, bumperOptions);

    // バンパーをフレーム奥へ繋ぐスプリング制約（自然長20px → 最大押込15px時でも5px残り反転しない）
    const leftSpring = Constraint.create({
        pointA: { x: innerLeft - 20, y: bumperY },
        bodyB: leftBumper,
        pointB: { x: -BUMPER.WIDTH / 2, y: 0 },
        stiffness: PHYSICS.BUMPER_STIFFNESS,
        damping: PHYSICS.BUMPER_DAMPING
    });

    const rightSpring = Constraint.create({
        pointA: { x: innerRight + 20, y: bumperY },
        bodyB: rightBumper,
        pointB: { x: BUMPER.WIDTH / 2, y: 0 },
        stiffness: PHYSICS.BUMPER_STIFFNESS,
        damping: PHYSICS.BUMPER_DAMPING
    });

    Composite.add(world, [leftBumper, rightBumper, leftSpring, rightSpring]);

    return { engine, world };
}

/**
 * バンパーのY座標・角度・左右可動範囲を強制固定し、現在の押し込み状態および押し込み率を算出する内部関数
 * @returns {{ leftPressed: boolean, rightPressed: boolean, leftPushRatio: number, rightPushRatio: number }}
 */
function constrainBumpers() {
    if (!leftBumper || !rightBumper) {
        return {
            leftPressed: false,
            rightPressed: false,
            leftPushRatio: 0,
            rightPushRatio: 0
        };
    }

    const maxPush = BUMPER.MAX_PUSH || 15;
    const threshold = Math.max(1, BUMPER.PUSH_THRESHOLD || 9);

    // 左バンパー：フレーム側（左）への最大押し込み量〜休止位置の範囲にX座標をクランプ
    const clampedLeftX = Math.max(restXLeft - maxPush, Math.min(restXLeft, leftBumper.position.x));
    const leftVelX = (clampedLeftX !== leftBumper.position.x) ? 0 : leftBumper.velocity.x;
    Body.setPosition(leftBumper, { x: clampedLeftX, y: bumperY });
    Body.setAngle(leftBumper, 0);
    Body.setVelocity(leftBumper, { x: leftVelX, y: 0 });

    // 右バンパー：休止位置〜フレーム側（右）への最大押し込み量の範囲にX座標をクランプ
    const clampedRightX = Math.max(restXRight, Math.min(restXRight + maxPush, rightBumper.position.x));
    const rightVelX = (clampedRightX !== rightBumper.position.x) ? 0 : rightBumper.velocity.x;
    Body.setPosition(rightBumper, { x: clampedRightX, y: bumperY });
    Body.setAngle(rightBumper, 0);
    Body.setVelocity(rightBumper, { x: rightVelX, y: 0 });

    // フレーム側へ押し込まれた変位量・押し込み率（枠内赤点灯サイドバー連動用）・閾値判定を算出
    const leftPush = Math.max(0, restXLeft - clampedLeftX);
    const rightPush = Math.max(0, clampedRightX - restXRight);
    const leftPushRatio = Math.max(0, Math.min(1, leftPush / threshold));
    const rightPushRatio = Math.max(0, Math.min(1, rightPush / threshold));
    const leftPressed = leftPush > threshold;
    const rightPressed = rightPush > threshold;

    return {
        leftPressed,
        rightPressed,
        leftPushRatio,
        rightPushRatio
    };
}

/**
 * 1フレームの経過時間を複数サブステップ（PHYSICS.SUBSTEPS）に分割して物理演算を安定駆動する
 * @param {number} deltaMs - 経過フレーム時間（ミリ秒）
 * @param {Function|null} onBeforeSubStep - 各サブステップ更新直前に実行するコールバック (subDelta, stepIndex, totalSteps)
 */
export function stepPhysics(deltaMs = 1000 / 60, onBeforeSubStep = null) {
    if (!engine) return;

    // タブ復帰時などの極端な時間飛びによる物理爆発を防ぐためデルタ時間を安全範囲にクランプ
    const clampedDelta = Math.max(1, Math.min(deltaMs || (1000 / 60), 1000 / 30));
    const substeps = Math.max(1, PHYSICS.SUBSTEPS || 4);
    const subDelta = clampedDelta / substeps;

    for (let s = 0; s < substeps; s++) {
        if (typeof onBeforeSubStep === 'function') {
            onBeforeSubStep(subDelta, s, substeps);
        }
        Engine.update(engine, subDelta);
        constrainBumpers();
    }
}

/**
 * 毎フレーム呼ばれ、バンパーの姿勢・可動範囲を固定し、
 * 押し込み状態・赤点灯サイドバー連動用の押し込み率および左右同時押し込みの継続判定結果を返す
 * @param {number} deltaMs - 経過フレーム時間（ミリ秒）
 * @returns {{ leftPressed: boolean, rightPressed: boolean, leftPushRatio: number, rightPushRatio: number, bothPressedDurationMs: number, isGameOverTriggered: boolean }}
 */
export function updateBumpers(deltaMs = 1000 / 60) {
    const state = constrainBumpers();
    const safeDelta = Math.max(0, Math.min(deltaMs || (1000 / 60), 1000 / 15));

    if (state.leftPressed && state.rightPressed) {
        bothPressedDurationMs += safeDelta;
    } else {
        bothPressedDurationMs = 0;
    }

    const holdMs = BUMPER.GAME_OVER_HOLD_MS || 250;
    const isGameOverTriggered = bothPressedDurationMs >= holdMs;

    return {
        leftPressed: state.leftPressed,
        rightPressed: state.rightPressed,
        leftPushRatio: state.leftPushRatio,
        rightPushRatio: state.rightPushRatio,
        bothPressedDurationMs,
        isGameOverTriggered
    };
}