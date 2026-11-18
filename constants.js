/**
 * constants.js
 * sobosuba風パズルの物理パラメータ、ゼリーの定義、UIセーフエリア等の定数モジュール
 * 
 * GRAVITY規格の215pxセーフエリアや、ゼリーの合体・ゲームオーバー判定に必要な
 * 各種しきい値などをここで一元管理し、他モジュールから絶対パスでインポートして使用します。
 */

// ==========================================
// 1. 空間・基本サイズ設定
// ==========================================
export const GAME_WIDTH = 420;
export const GAME_HEIGHT = 700;
export const WALL_THICKNESS = 60;
export const DROP_Y = 60;

// ==========================================
// 2. ゼリーの定義（スコア値ごとの色・半径・テキスト色）
// ==========================================
// 合体するごとに半径が大きくなり、質量も増加する設定のベースとなります
export const JELLY_CONFIG = {
    1:    { color: '#ff4757', radius: 18, text: '#fff' },
    2:    { color: '#ffa502', radius: 24, text: '#fff' },
    4:    { color: '#eccc68', radius: 32, text: '#000' },
    8:    { color: '#7bed9f', radius: 40, text: '#000' },
    16:   { color: '#2ed573', radius: 48, text: '#fff' },
    32:   { color: '#1e90ff', radius: 56, text: '#fff' },
    64:   { color: '#3742fa', radius: 64, text: '#fff' },
    128:  { color: '#5352ed', radius: 72, text: '#fff' },
    256:  { color: '#9b59b6', radius: 82, text: '#fff' },
    512:  { color: '#ff6b81', radius: 94, text: '#fff' },
    1024: { color: '#ff7f50', radius: 106, text: '#fff' },
    2048: { color: '#e84118', radius: 120, text: '#fff' },
    4096: { color: '#c23616', radius: 135, text: '#fff' },
    8192: { color: '#8c7ae6', radius: 150, text: '#fff' }
};

// ==========================================
// 3. 物理演算（Matter.js）チューニングパラメータ
// ==========================================
export const PHYSICS = {
    GRAVITY_Y: 1.5,           // 重力（デフォルトより強めにして堆積圧力を高める）
    RESTITUTION: 0.2,         // 反発係数（ゼリーのぷにぷに感と跳ね返り）
    FRICTION: 0.3,            // 摩擦係数（滑りすぎず、積み上がりやすくする）
    DENSITY_BASE: 0.001,      // 密度の基準値（半径に応じてスケールさせる）
    SPRING_STIFFNESS: 0.08,   // バンパーを支えるバネ（Constraint）の硬さ
    SPRING_DAMPING: 0.1       // バネの減衰率
};

// ==========================================
// 4. 左右バンパー（ゲームオーバー判定スイッチ）の設定
// ==========================================
export const BUMPER = {
    WIDTH: 24,
    HEIGHT_RATIO: 0.55,       // 画面高さに対するバンパーの高さ割合（55%）
    Y_RATIO: 0.6,             // 画面上でのY座標位置（60%、少し下寄り）
    PUSH_THRESHOLD: 12        // このピクセル数以上押し込まれたら赤色(ON)と判定する
};

// ==========================================
// 5. UI・GRAVITY環境設定
// ==========================================
export const UI = {
    SAFE_BOTTOM_PX: 215,      // GRAVITYネイティブ招待ボタンとの干渉を防ぐための下部余白
    DROP_COOLDOWN_MS: 800     // 次のゼリーを落とせるようになるまでのクールダウン時間
};