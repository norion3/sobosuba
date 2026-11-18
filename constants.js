/**
 * constants.js
 * sobosuba風パズルの物理パラメータ、ゼリーの定義、UIセーフエリア等の定数モジュール
 * 
 * ソフトボディ設定や、プレイ領域を圧迫しないスリム化されたバンパー設定を含みます。
 * 全モジュールから絶対パスでインポートして使用されます。
 */

// ==========================================
// 1. 空間・基本サイズ設定
// ==========================================
export const GAME_WIDTH = 420;
export const GAME_HEIGHT = 700;
export const WALL_THICKNESS = 60;
export const DROP_Y = 60;

// ==========================================
// 2. ゼリー（ソフトボディ）の定義
// ==========================================
// スコア値ごとの色、基本半径、テキスト色、およびソフトボディの外殻を構成するパーティクル数
export const JELLY_CONFIG = {
    1:    { color: '#ff4757', radius: 18, text: '#fff', particles: 8 },
    2:    { color: '#ffa502', radius: 24, text: '#fff', particles: 9 },
    4:    { color: '#eccc68', radius: 32, text: '#000', particles: 10 },
    8:    { color: '#7bed9f', radius: 40, text: '#000', particles: 11 },
    16:   { color: '#2ed573', radius: 48, text: '#fff', particles: 12 },
    32:   { color: '#1e90ff', radius: 56, text: '#fff', particles: 13 },
    64:   { color: '#3742fa', radius: 64, text: '#fff', particles: 14 },
    128:  { color: '#5352ed', radius: 72, text: '#fff', particles: 15 },
    256:  { color: '#9b59b6', radius: 82, text: '#fff', particles: 16 },
    512:  { color: '#ff6b81', radius: 94, text: '#fff', particles: 17 },
    1024: { color: '#ff7f50', radius: 106, text: '#fff', particles: 18 },
    2048: { color: '#e84118', radius: 120, text: '#fff', particles: 19 },
    4096: { color: '#c23616', radius: 135, text: '#fff', particles: 20 },
    8192: { color: '#8c7ae6', radius: 150, text: '#fff', particles: 22 }
};

// ==========================================
// 3. 物理演算（Matter.js）チューニングパラメータ
// ==========================================
export const PHYSICS = {
    GRAVITY_Y: 1.2,           // 重力（堆積しやすく調整）
    RESTITUTION: 0.1,         // 反発係数（ソフトボディは跳ねすぎないよう低めに設定）
    FRICTION: 0.5,            // 摩擦係数（滑りすぎず、積み上がりやすくする）
    
    // ソフトボディ関連
    DENSITY_CORE: 0.002,      // 中心コアの密度
    DENSITY_PARTICLE: 0.001,  // 外殻パーティクルの密度
    SOFTBODY_STIFFNESS: 0.2,  // ソフトボディ内部のバネ（Constraint）の硬さ
    SOFTBODY_DAMPING: 0.05,   // ソフトボディ内部のバネの減衰
    
    // バンパー関連
    BUMPER_STIFFNESS: 0.05,   // バンパーを支えるバネの硬さ（ゼリーの圧力で押し込まれるように柔らかめ）
    BUMPER_DAMPING: 0.1       // バンパーのバネの減衰
};

// ==========================================
// 4. スリム化された左右バンパーの設定
// ==========================================
export const BUMPER = {
    WIDTH: 12,                // ご要望に合わせてプレイ領域を圧迫しないよう極限までスリム化(12px)
    HEIGHT_RATIO: 0.55,       // 画面高さに対するバンパーの高さ割合（55%）
    Y_RATIO: 0.6,             // 画面上でのY座標位置（60%、少し下寄り）
    PUSH_THRESHOLD: 8         // このピクセル数以上押し込まれたら赤色(ON)と判定する
};

// ==========================================
// 5. UI・GRAVITY環境設定
// ==========================================
export const UI = {
    SAFE_BOTTOM_PX: 215,      // GRAVITYネイティブ招待ボタンとの干渉を防ぐための下部余白
    DROP_COOLDOWN_MS: 800     // 次のゼリーを落とせるようになるまでのクールダウン時間
};