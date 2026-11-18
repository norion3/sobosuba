/**
 * physics.js
 * @version v2.0 (Bugfix Step 3)
 * @changes
 *   - 静的壁とバンパーの衝突フィルタ（collisionFilter）を分離し、バンパーが壁側へ正しく押し込める構造へ修正
 *   - updateBumpers() の押し込み判定符号を正しい向きへ修正し、押し込みすぎ・飛び出しすぎを防ぐX座標クランプを追加
 *   - 上方向への飛び出し・画面外消滅を防ぐ見えない天井壁を追加
 *   - GRAVITYキャッシュ不整合対策として constants.js の絶対パスに ?v=2 を付与
 * 
 * Matter.jsを用いた物理世界の初期化、壁の生成、および
 * ゲームオーバー条件となる「左右のスリムバンパースイッチ」を構築・制御するモジュール
 * 
 * GRAVITY起動エラーを根絶するため、HTMLの<script>タグ依存を排除し、
 * CDN（esm.sh）経由でMatter.jsを直接ESModuleとしてインポートします。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, WALL_THICKNESS, BUMPER, PHYSICS, CONTAINER } from '/sobosuba/constants.js?v=2';

// Matter.jsのモジュールエイリアス
const Engine = Matter.Engine;
const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

// 衝突カテゴリ定義（壁とバンパーは互いにすり抜け、双方ともゼリーとは衝突する）
const CATEGORY_DEFAULT = 0x0001; // ゼリー等のデフォルト剛体
const CATEGORY_WALL    = 0x0002; // 容器の壁・床・天井・スロープ
const CATEGORY_BUMPER  = 0x0004; // 左右のバンパースイッチ

// 物理世界の状態を保持
export let engine;
export let world;
export let leftBumper;
export let rightBumper;

// バンパーの基準（休止）位置
let restXLeft;
let restXRight;
let bumperY;

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
    
    // ゼリーが積み上がって横圧力を生むように重力を少し強めに設定
    engine.gravity.y = PHYSICS.GRAVITY_Y;

    // --- 床・天井・見えない壁・底面角カットスロープの生成 ---
    const wallOptions = { 
        isStatic: true, 
        render: { visible: false }, 
        friction: PHYSICS.FRICTION, 
        restitution: 0.1,
        // ゼリーとは衝突し、バンパーとは衝突しないフィルタ設定
        collisionFilter: {
            category: CATEGORY_WALL,
            mask: CATEGORY_DEFAULT
        }
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
        // 天井（上方向への飛び出し・画面外消滅を防止）
        Bodies.rectangle(GAME_WIDTH / 2, -WALL_THICKNESS / 2, GAME_WIDTH * 2, WALL_THICKNESS, { ...wallOptions, label: 'ceiling' }),
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
        friction: 0.05, 
        restitution: 0.1,
        density: 0.05, // 重くして簡単には動かないようにする（ゼリーの圧力が必要）
        label: 'bumper',
        // ゼリーとは衝突し、左右の静的壁とは衝突せず壁側へ押し込めるフィルタ設定
        collisionFilter: {
            category: CATEGORY_BUMPER,
            mask: CATEGORY_DEFAULT
        }
    };

    // プレイ領域を圧迫しないスリムな左バンパー
    leftBumper = Bodies.rectangle(restXLeft, bumperY, BUMPER.WIDTH, bumperHeight, bumperOptions);
    // プレイ領域を圧迫しないスリムな右バンパー
    rightBumper = Bodies.rectangle(restXRight, bumperY, BUMPER.WIDTH, bumperHeight, bumperOptions);

    // バンパーを壁に繋ぐスプリング（バネ）制約
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
 * 毎フレーム呼ばれ、バンパーの姿勢と可動範囲を強制固定し、壁側への押し込まれ具合を判定して返す
 * @returns {Object} 左右バンパーが閾値以上押し込まれているか(isPressed)の判定結果
 */
export function updateBumpers() {
    if (!leftBumper || !rightBumper) return { leftPressed: false, rightPressed: false };

    const maxPush = BUMPER.MAX_PUSH || 14;

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

    // 壁側へ押し込まれた変位量の算出と閾値判定
    const leftPressed = (restXLeft - clampedLeftX) > BUMPER.PUSH_THRESHOLD;
    const rightPressed = (clampedRightX - restXRight) > BUMPER.PUSH_THRESHOLD;

    return { leftPressed, rightPressed };
}