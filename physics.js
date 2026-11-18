/**
 * physics.js
 * Matter.jsを用いた物理世界の初期化、壁の生成、および
 * ゲームオーバー条件となる「左右のスリムバンパースイッチ」を構築・制御するモジュール
 * 
 * GRAVITY起動エラーを根絶するため、HTMLの<script>タグ依存を排除し、
 * CDN（esm.sh）経由でMatter.jsを直接ESModuleとしてインポートします。
 */

import Matter from 'https://esm.sh/matter-js';
import { GAME_WIDTH, GAME_HEIGHT, WALL_THICKNESS, BUMPER, PHYSICS } from '/sobosuba/constants.js';

// Matter.jsのモジュールエイリアス
const Engine = Matter.Engine;
const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Constraint = Matter.Constraint;
const Body = Matter.Body;

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

    // --- 床・見えない壁の生成 ---
    const wallOptions = { 
        isStatic: true, 
        render: { visible: false }, 
        friction: PHYSICS.FRICTION, 
        restitution: 0.1 
    };

    Composite.add(world, [
        // 床 (厚めに設定してすり抜け防止)
        Bodies.rectangle(GAME_WIDTH / 2, GAME_HEIGHT + WALL_THICKNESS / 2, GAME_WIDTH * 2, WALL_THICKNESS, wallOptions),
        // 左右の完全な見えない壁（バンパーの裏側で、ゼリーの漏れを最終的に防ぐ）
        Bodies.rectangle(-WALL_THICKNESS / 2, GAME_HEIGHT / 2, WALL_THICKNESS, GAME_HEIGHT * 2, wallOptions),
        Bodies.rectangle(GAME_WIDTH + WALL_THICKNESS / 2, GAME_HEIGHT / 2, WALL_THICKNESS, GAME_HEIGHT * 2, wallOptions)
    ]);

    // --- 左右スリムスイッチ（バンパー）機構の構築 ---
    bumperY = GAME_HEIGHT * BUMPER.Y_RATIO;
    const bumperHeight = GAME_HEIGHT * BUMPER.HEIGHT_RATIO;
    
    // バンパーの初期X座標（壁にめり込んでいる状態を休止状態とする）
    restXLeft = BUMPER.WIDTH / 2;
    restXRight = GAME_WIDTH - (BUMPER.WIDTH / 2);

    const bumperOptions = { 
        isStatic: false, // バネで動くようにスライドアクションを許可
        friction: 0.05, 
        restitution: 0.1,
        density: 0.05, // 重くして簡単には動かないようにする（ゼリーの圧力が必要）
        label: 'bumper'
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
 * 毎フレーム呼ばれ、バンパーの姿勢を強制固定し、押し込まれ具合を判定して返す
 * @returns {Object} 左右バンパーが閾値以上押し込まれているか(isPressed)の判定結果
 */
export function updateBumpers() {
    if (!leftBumper || !rightBumper) return { leftPressed: false, rightPressed: false };

    // バンパーがゼリーに押されて縦にズレたり回転したりしないよう、Y座標と角度を強制固定（スライドドアの挙動）
    Body.setPosition(leftBumper, { x: leftBumper.position.x, y: bumperY });
    Body.setAngle(leftBumper, 0);
    Body.setVelocity(leftBumper, { x: leftBumper.velocity.x, y: 0 });

    Body.setPosition(rightBumper, { x: rightBumper.position.x, y: bumperY });
    Body.setAngle(rightBumper, 0);
    Body.setVelocity(rightBumper, { x: rightBumper.velocity.x, y: 0 });

    // 押し込み量の算出と閾値判定
    const leftPressed = (leftBumper.position.x - restXLeft) > BUMPER.PUSH_THRESHOLD;
    const rightPressed = (restXRight - rightBumper.position.x) > BUMPER.PUSH_THRESHOLD;

    return { leftPressed, rightPressed };
}