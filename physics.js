/**
 * physics.js
 * @version v5.0 (Final Overhaul & Refactoring Step 2)
 * @changes
 *   - constants.js の COLLISION_CATEGORY を導入し、壁・天井・床・45度スロープは全ゼリー（FIELD_JELLY / BAR_FLOATING / BAR_HOPPING）と衝突し、バンパーは下段の FIELD_JELLY のみに反応する厳密な衝突フィルタへ更新（上段ホップ誤爆ゼロ）
 *   - 枠外赤LED縦バー連動および BUMPER.GAME_OVER_HOLD_MS（250ms）準拠のため、updateBumpers() から左右バンパーの押し込み率（leftPushRatio / rightPushRatio）を返却するよう拡張
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスを /sobosuba/constants.js?v=5 へ統一
 * 
 * Matter.jsを用いた物理世界の初期化、壁の生成、サブステップ駆動、および
 * ゲームオーバー条件となる「左右のスリムバンパースイッチ」を構築・制御するモジュール
 * 
 * GRAVITY起動エラーを根絶するため、HTMLの<script>タグ依存を排除し、
 * CDN（esm.sh）経由でMatter.jsを直接ESModuleとしてインポートします。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, WALL_THICKNESS, BUMPER, PHYSICS, CONTAINER, COLLISION_CATEGORY } from '/sobosuba/constants.js?v=5';

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
 * 座標 (x, y) を容器の壁・天井・床および底面左右の45度角カットスロープの内側へ安全にクランプする
 * （softbody.js / overlap_solver.js の PBD面積補正・非侵入排斥ソルバーによるスロープ貫通を防止）
 * @param {number} x - 判定対象のX座標
 * @param {number} y - 判定対象のY座標
 * @param {number} margin - 壁・スロープ面から確保する内側マージン（ビーズ半径など）
 * @param {{ x: number, y: number }|null} out - GC負荷削減用の出力先オブジェクト（省略時は新規作成）
 * @returns {{ x: number, y: number }} クランプ後の座標
 */
export function clampPointToContainer(x, y, margin = 0, out = null) {
    const safeMargin = Math.max(0, margin);
    let cx = Math.max(safeMargin, Math.min(GAME_WIDTH - safeMargin, x));
    let cy = Math.max(safeMargin, Math.min(GAME_HEIGHT - safeMargin, y));

    const cut = CONTAINER.CORNER_CUT_SIZE;
    if (cut > 0) {
        const invSqrt2 = Math.SQRT1_2;

        // 左下45度スロープ: 頂点 (0, GAME_HEIGHT - cut) - (cut, GAME_HEIGHT)
        // 内側（右上）法線ベクトル = (invSqrt2, -invSqrt2)
        const leftDist = (cx - cy + GAME_HEIGHT - cut) * invSqrt2;
        if (leftDist < safeMargin) {
            const push = safeMargin - leftDist;
            cx += push * invSqrt2;
            cy -= push * invSqrt2;
        }

        // 右下45度スロープ: 頂点 (GAME_WIDTH - cut, GAME_HEIGHT) - (GAME_WIDTH, GAME_HEIGHT - cut)
        // 内側（左上）法線ベクトル = (-invSqrt2, -invSqrt2)
        const rightDist = (GAME_WIDTH + GAME_HEIGHT - cut - cx - cy) * invSqrt2;
        if (rightDist < safeMargin) {
            const push = safeMargin - rightDist;
            cx -= push * invSqrt2;
            cy -= push * invSqrt2;
        }

        // スロープ押し戻し後の最終的な矩形内安全クランプ
        cx = Math.max(safeMargin, Math.min(GAME_WIDTH - safeMargin, cx));
        cy = Math.max(safeMargin, Math.min(GAME_HEIGHT - safeMargin, cy));
    }

    if (out) {
        out.x = cx;
        out.y = cy;
        return out;
    }
    return { x: cx, y: cy };
}

/**
 * 物理エンジンの初期化と壁・スリムバンパーの生成
 */
export function initPhysics() {
    // 既存のエンジンがあればクリア
    if (engine) {
        Matter.Engine.clear(engine);
    }

    engine = Engine.create();
    world = engine.world;
    bothPressedDurationMs = 0;

    // ゼリーが積み上がって横圧力を生むように重力を設定
    engine.gravity.y = PHYSICS.GRAVITY_Y;

    // --- 床・天井・見えない壁・底面角カットスロープの生成（超低摩擦化） ---
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

    // 容器底面の左右45度角カット（スロープ壁）の座標計算
    const cut = CONTAINER.CORNER_CUT_SIZE;
    const slopeLength = cut * Math.SQRT2 * 1.6;
    const halfThickDiag = (WALL_THICKNESS / 2) * Math.SQRT1_2;

    const leftSlope = Bodies.rectangle(
        (cut / 2) - halfThickDiag,
        (GAME_HEIGHT - cut / 2) + halfThickDiag,
        slopeLength,
        WALL_THICKNESS,
        { ...wallOptions, angle: Math.PI / 4, label: 'corner_slope_left' }
    );

    const rightSlope = Bodies.rectangle(
        (GAME_WIDTH - cut / 2) + halfThickDiag,
        (GAME_HEIGHT - cut / 2) + halfThickDiag,
        slopeLength,
        WALL_THICKNESS,
        { ...wallOptions, angle: -Math.PI / 4, label: 'corner_slope_right' }
    );

    Composite.add(world, [
        // 天井（上方向への飛び出し防止 ＆ 上段ホップ時の柔らかいクッション反射）
        Bodies.rectangle(GAME_WIDTH / 2, -WALL_THICKNESS / 2, GAME_WIDTH * 2, WALL_THICKNESS, ceilingOptions),
        // 床 (厚めに設定してすり抜け防止)
        Bodies.rectangle(GAME_WIDTH / 2, GAME_HEIGHT + WALL_THICKNESS / 2, GAME_WIDTH * 2, WALL_THICKNESS, wallOptions),
        // 左右の完全な見えない壁（バンパーの裏側で、ゼリーの漏れを最終的に防ぐ）
        Bodies.rectangle(-WALL_THICKNESS / 2, GAME_HEIGHT / 2, WALL_THICKNESS, GAME_HEIGHT * 2, wallOptions),
        Bodies.rectangle(GAME_WIDTH + WALL_THICKNESS / 2, GAME_HEIGHT / 2, WALL_THICKNESS, GAME_HEIGHT * 2, wallOptions),
        // 底面の左右45度角カットスロープ壁
        leftSlope,
        rightSlope
    ]);

    // --- 左右スリムスイッチ（バンパー）機構の構築 ---
    bumperY = GAME_HEIGHT * BUMPER.Y_RATIO;
    const bumperHeight = GAME_HEIGHT * BUMPER.HEIGHT_RATIO;

    // バンパーの初期X座標（フィールド内側へ突出している状態を休止状態とする）
    restXLeft = BUMPER.WIDTH / 2;
    restXRight = GAME_WIDTH - (BUMPER.WIDTH / 2);

    const bumperOptions = {
        isStatic: false, // バネで動くようにスライドアクションを許可
        friction: PHYSICS.FRICTION,
        frictionStatic: PHYSICS.FRICTION_STATIC,
        restitution: 0.15,
        density: 0.05, // 重くして簡単には動かないようにする（ゼリーの圧力が必要）
        label: 'bumper',
        // 下段の FIELD_JELLY のみと衝突し、壁や上段待機・ホップ中ゼリーとは干渉しないフィルタ設定
        collisionFilter: {
            category: COLLISION_CATEGORY.BUMPER,
            mask: COLLISION_CATEGORY.FIELD_JELLY
        }
    };

    // プレイ領域を圧迫しないスリムな左バンパー
    leftBumper = Bodies.rectangle(restXLeft, bumperY, BUMPER.WIDTH, bumperHeight, bumperOptions);
    // プレイ領域を圧迫しないスリムな右バンパー
    rightBumper = Bodies.rectangle(restXRight, bumperY, BUMPER.WIDTH, bumperHeight, bumperOptions);

    // バンパーを壁に繋ぐスプリング（バネ）制約（SUBSTEPS=4 正規化済みの剛性・減衰を使用）
    const leftSpring = Constraint.create({
        pointA: { x: -20, y: bumperY },
        bodyB: leftBumper,
        pointB: { x: -BUMPER.WIDTH / 2, y: 0 },
        stiffness: PHYSICS.BUMPER_STIFFNESS,
        damping: PHYSICS.BUMPER_DAMPING
    });

    const rightSpring = Constraint.create({
        pointA: { x: GAME_WIDTH + 20, y: bumperY },
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

    const maxPush = BUMPER.MAX_PUSH || 14;
    const threshold = Math.max(1, BUMPER.PUSH_THRESHOLD || 8);

    // 左バンパー：壁側（左）への最大押し込み量〜休止位置の範囲にX座標をクランプ
    const clampedLeftX = Math.max(restXLeft - maxPush, Math.min(restXLeft, leftBumper.position.x));
    const leftVelX = (clampedLeftX !== leftBumper.position.x) ? 0 : leftBumper.velocity.x;
    Body.setPosition(leftBumper, { x: clampedLeftX, y: bumperY });
    Body.setAngle(leftBumper, 0);
    Body.setVelocity(leftBumper, { x: leftVelX, y: 0 });

    // 右バンパー：休止位置〜壁側（右）への最大押し込み量の範囲にX座標をクランプ
    const clampedRightX = Math.max(restXRight, Math.min(restXRight + maxPush, rightBumper.position.x));
    const rightVelX = (clampedRightX !== rightBumper.position.x) ? 0 : rightBumper.velocity.x;
    Body.setPosition(rightBumper, { x: clampedRightX, y: bumperY });
    Body.setAngle(rightBumper, 0);
    Body.setVelocity(rightBumper, { x: rightVelX, y: 0 });

    // 壁側へ押し込まれた変位量・押し込み率（枠外赤LED連動用）・閾値判定を算出
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
 * 押し込み状態・枠外赤LED連動用の押し込み率および左右同時押し込みの継続判定結果を返す
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