/**
 * constants.js
 * sobosuba風パズルの物理パラメータ、ゼリーの定義、UIセーフエリア等の定数モジュール
 * 
 * 本家準拠のネオンカラー配色、上部バンパー設定、および演出用定数を含みます。
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
// 本家準拠：ビビッドなネオンカラー、黒文字統一、およびソフトボディの外殻を構成するパーティクル数
export const JELLY_CONFIG = {
    1:    { color: '#ff1e46', radius: 18, text: '#000', particles: 8 },  // ビビッドレッド
    2:    { color: '#fffa15', radius: 24, text: '#000', particles: 9 },  // レモンイエロー
    4:    { color: '#39ff14', radius: 32, text: '#000', particles: 10 }, // ネオングリーン
    8:    { color: '#00fa9a', radius: 40, text: '#000', particles: 11 }, // ミントグリーン
    16:   { color: '#00bfff', radius: 48, text: '#000', particles: 12 }, // スカイブルー
    32:   { color: '#a200ff', radius: 56, text: '#000', particles: 13 }, // ビビッドパープル
    64:   { color: '#ff00ff', radius: 64, text: '#000', particles: 14 }, // マゼンタ
    128:  { color: '#ff6600', radius: 72, text: '#000', particles: 15 }, // オレンジ
    256:  { color: '#ccff00', radius: 82, text: '#000', particles: 16 }, // ライムイエロー
    512:  { color: '#e0ffff', radius: 94, text: '#000', particles: 17 }, // ペールミント(白系)
    1024: { color: '#ff1493', radius: 106, text: '#000', particles: 18 }, // ディープピンク
    2048: { color: '#0000ff', radius: 120, text: '#000', particles: 19 }, // ディープブルー
    4096: { color: '#da70d6', radius: 135, text: '#000', particles: 20 }, // ライトパープル
    8192: { color: '#ff007f', radius: 150, text: '#000', particles: 22 }  // ローズレッド
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
    BUMPER_DAMPING: 0.1,      // バンパーのバネの減衰

    // スリングショット（引っ張り発射）関連
    SLINGSHOT_FORCE_MULTIPLIER: 0.00015, // 引っ張り距離に対する力（Force）の係数
    SLINGSHOT_MAX_DRAG: 150,             // 引っ張れる最大距離（ピクセル）
    
    // 連鎖合体（Radial Force）関連
    MERGE_RADIAL_FORCE: 0.015            // 合体生成時に周囲のゼリーを弾き飛ばす力の強さ
};

// ==========================================
// 4. 上部バンパー（危険判定スイッチ）の設定
// ==========================================
export const BUMPER = {
    WIDTH: 16,                // 壁から飛び出る厚み（かまぼこ型）
    HEIGHT_RATIO: 0.15,       // 画面高さに対するバンパーの高さ割合（15%：短くする）
    Y_RATIO: 0.25,            // 画面上でのY座標位置（25%：上部に配置する）
    PUSH_THRESHOLD: 8         // このピクセル数以上押し込まれたら赤色(ON)と判定する
};

// ==========================================
// 5. 演出およびスコア計算用パラメータ（追加）
// ==========================================
export const EFFECTS = {
    MERGE_EXPAND_FRAMES: 10,  // 合体時にぷるんと膨張させるフレーム数
    MERGE_EXPAND_SCALE: 1.15  // 膨張時の最大スケール倍率
};

export const SCORE = {
    COMBO_MULTIPLIER: 1.5     // 連鎖発生時（短い間隔で連続合体した際）の追加ボーナス倍率
};

// ==========================================
// 6. UI・GRAVITY環境設定
// ==========================================
export const UI = {
    SAFE_BOTTOM_PX: 215,      // GRAVITYネイティブ招待ボタンとの干渉を防ぐための下部余白
    DROP_COOLDOWN_MS: 800,    // 次のゼリーを撃てるようになるまでのクールダウン時間
    QUEUE_SIZE: 4             // 常に表示・保持する次のゼリーの数
};