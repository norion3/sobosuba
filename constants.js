/**
 * constants.js
 * @version v3.0 (Overhaul Step 1)
 * @changes
 *   - 粘り気を解消するため、超低摩擦（FRICTION: 0.03）・反発（RESTITUTION: 0.25）・低減衰パラメータへ刷新
 *   - 中空ビーズリング物理（ビーズ数 12〜24、隣接皮バネ、1つ飛ばし曲げ拘束、PBD面積保存圧力、アンチ裏返り修復、4分割サブステップ）用定数を定義
 *   - 本家の空間回収比率（2個合体で約1/3省スペース化）に準拠したサイズ成長カーブ（半径比 約1.18）へ調整
 *   - 上部フロートバーの左右2点クリアランス検知スポーナー、低減衰横スライド、セーフティスポーン、および短い発射クールダウン（220ms）を定義
 *   - バンパー同時押し込み継続判定時間（200ms）、将来的なテーマ切替用カラーパレット構造、およびGRAVITY自動画面レイアウト用セーフ余白を追加
 * 
 * sobosuba風パズルの物理パラメータ、ゼリーの定義、UIセーフエリア等の定数モジュール
 * 全モジュールから絶対パス（/sobosuba/constants.js?v=3）でインポートして使用されます。
 */

// ==========================================
// 1. 空間・基本サイズ設定
// ==========================================
export const GAME_WIDTH = 420;
export const GAME_HEIGHT = 700;
export const WALL_THICKNESS = 60;
export const DROP_Y = 60;

// ==========================================
// 2. カラーテーマパレット ＆ ゼリー（Sobo）の定義
// ==========================================
// 将来的なカラースタイル切替を見据えたパレット構造
export const COLOR_THEMES = {
    default: {
        name: 'default',
        background: '#080808',
        containerBg: '#080808',
        wallStroke: '#3a3a3a',
        cornerFill: '#262626',
        outline: '#000000',
        text: '#000000',
        unmergedTextAlpha: 0.45,
        colors: {
            1:     '#ff1e46', // ビビッドレッド
            2:     '#fffa15', // レモンイエロー
            4:     '#39ff14', // ネオングリーン
            8:     '#00fa9a', // ミントグリーン
            16:    '#00bfff', // スカイブルー
            32:    '#a200ff', // ビビッドパープル
            64:    '#ff00ff', // マゼンタ
            128:   '#ff6600', // オレンジ
            256:   '#ccff00', // ライムイエロー
            512:   '#e0ffff', // ペールミント(白系)
            1024:  '#ff1493', // ディープピンク
            2048:  '#0000ff', // ディープブルー
            4096:  '#da70d6', // ライトパープル
            8192:  '#ff007f', // ローズレッド
            16384: '#00ffd5'  // シアンネオン
        }
    }
};

export const ACTIVE_THEME = COLOR_THEMES.default;

// 本家準拠：空間回収型サイズカーブ（半径比 約1.18）と中空ビーズリング数（12〜24）
export const JELLY_CONFIG = {
    1:     { color: ACTIVE_THEME.colors[1],     radius: 18,   text: ACTIVE_THEME.text, particles: 12 },
    2:     { color: ACTIVE_THEME.colors[2],     radius: 21.5, text: ACTIVE_THEME.text, particles: 12 },
    4:     { color: ACTIVE_THEME.colors[4],     radius: 26,   text: ACTIVE_THEME.text, particles: 13 },
    8:     { color: ACTIVE_THEME.colors[8],     radius: 31,   text: ACTIVE_THEME.text, particles: 14 },
    16:    { color: ACTIVE_THEME.colors[16],    radius: 37,   text: ACTIVE_THEME.text, particles: 15 },
    32:    { color: ACTIVE_THEME.colors[32],    radius: 44,   text: ACTIVE_THEME.text, particles: 16 },
    64:    { color: ACTIVE_THEME.colors[64],    radius: 52,   text: ACTIVE_THEME.text, particles: 17 },
    128:   { color: ACTIVE_THEME.colors[128],   radius: 62,   text: ACTIVE_THEME.text, particles: 18 },
    256:   { color: ACTIVE_THEME.colors[256],   radius: 74,   text: ACTIVE_THEME.text, particles: 19 },
    512:   { color: ACTIVE_THEME.colors[512],   radius: 88,   text: ACTIVE_THEME.text, particles: 20 },
    1024:  { color: ACTIVE_THEME.colors[1024],  radius: 104,  text: ACTIVE_THEME.text, particles: 21 },
    2048:  { color: ACTIVE_THEME.colors[2048],  radius: 123,  text: ACTIVE_THEME.text, particles: 22 },
    4096:  { color: ACTIVE_THEME.colors[4096],  radius: 145,  text: ACTIVE_THEME.text, particles: 23 },
    8192:  { color: ACTIVE_THEME.colors[8192],  radius: 170,  text: ACTIVE_THEME.text, particles: 24 },
    16384: { color: ACTIVE_THEME.colors[16384], radius: 196,  text: ACTIVE_THEME.text, particles: 24 }
};

// ==========================================
// 3. 物理演算（Matter.js ＋ 中空ビーズリングPBD）パラメータ
// ==========================================
export const PHYSICS = {
    GRAVITY_Y: 1.15,              // 重力
    SUBSTEPS: 4,                  // 1フレームあたりの物理サブステップ分割数（安定性・耐崩壊性の要）
    RESTITUTION: 0.25,            // 反発係数（粘土感を消し、ボヨンと心地よく弾む弾性）
    FRICTION: 0.03,               // 超低摩擦（粘り気を無くし、狭い隙間へニュルンと滑り込む）
    FRICTION_STATIC: 0.02,        // 静止摩擦も極めて低く設定
    FRICTION_AIR: 0.005,          // 低い空気抵抗（軽快な揺れを維持）

    // 中空ビーズリング（中心コアなし）関連パラメータ
    DENSITY_PARTICLE: 0.0012,     // 外周ビーズ剛体の密度
    BEAD_RADIUS_RATIO: 0.22,      // 全体半径に対する外周ビーズ半径の比率
    SKIN_STIFFNESS: 0.55,         // 隣接ビーズ間の皮の張り（表面張力バネ、わずかな伸縮を許容）
    BEND_STIFFNESS: 0.14,         // 1つ飛ばしビーズ間の弱い曲げ拘束（シワ折れ・鋭角崩壊防止）
    SOFTBODY_DAMPING: 0.04,       // バネの減衰（低めに保ちプルプル感を維持）

    // PBD（位置ベース）面積保存 ＆ アンチ裏返り自動修復
    PBD_AREA_STIFFNESS: 0.65,     // 不足面積を外向き法線へ直接押し戻すPBD補正強度
    PBD_MAX_CORRECTION: 2.5,      // 1サブステップあたりの最大位置補正量（px）
    SOFTBODY_PRESSURE: 0.00055,   // 補助的な法線方向の内部圧力係数
    INVERSION_AREA_RATIO: 0.25,   // 符号付き面積がこの比率未満になったら即座に形状自動修復
    SOFTBODY_MIN_DIST_RATIO: 0.45,// 重心からの最小距離比率（ペシャンコ防止）
    MAX_PARTICLE_SPEED: 15,       // すり抜け（トンネリング）・物理爆発防止の最大速度上限

    // 互換維持用（段階的移行用）
    DENSITY_CORE: 0.002,
    SOFTBODY_STIFFNESS: 0.04,
    SOFTBODY_PERIMETER_STIFFNESS: 0.55,

    // バンパー関連
    BUMPER_STIFFNESS: 0.05,       // バンパーを支えるバネの硬さ
    BUMPER_DAMPING: 0.1,          // バンパーのバネの減衰

    // 順方向ダイレクトエイム関連（加算速度発射対応）
    SLINGSHOT_FORCE_MULTIPLIER: 0.00015, // 互換用
    SLINGSHOT_MAX_DRAG: 150,             // 互換用
    AIM_FORCE_MULTIPLIER: 0.105,         // 順方向ダイレクトエイム発射時の初速係数
    AIM_MAX_DRAG: 150,                   // 順方向エイムの最大ドラッグ距離（px）
    AIM_CANCEL_RADIUS: 18,               // ドラッグ後に戻した際のキャンセル判定半径（px）
    AIM_MIN_UPWARD_RATIO: -0.22,         // 水平〜わずかな上向き横撃ちまで許可（極端な真上逆流のみ制限）

    // 連鎖合体（Radial Force）関連
    MERGE_RADIAL_FORCE: 0.012            // フィールド内合体時に周囲を適度に動かす膨張パルス
};

// ==========================================
// 4. 上部フロートバー（物理待機領域 ＆ 左右2点スポーナー）の設定
// ==========================================
export const FLOAT_BAR = {
    Y: 78,                        // 上部フロートバーの中心Y座標
    MAX_COUNT: 5,                 // バー上に保持する目安最大ゼリー数
    PADDING_X: 28,                // 左右の壁からの余白
    LEFT_SPAWN_X: 38,             // 左側スポーナーの出現基準X座標
    RIGHT_SPAWN_X: 382,           // 右側スポーナーの出現基準X座標
    SPAWN_CLEARANCE_MARGIN: 6,    // スポーナー空き検知に必要な追加余白（px）
    SPAWN_ENTRY_VELOCITY: 1.8,    // 左右端から中央側へ滑り込む初期速度
    SPRING_STIFFNESS: 0.09,       // バーY高度へ保持する弾性フック強度
    PACK_FORCE: 0.00006,          // バー上で穏やかに中央寄りへ保つ微弱引力
    X_DAMPING: 0.985,             // 横方向の極低ダンピング（スルスル滑る本家挙動）
    Y_DAMPING: 0.88,              // 縦方向の揺れを抑えるダンピング
    SPAWN_DELAY_MS: 280,          // スポーナー補充の最小間隔（ms）
    SAFETY_SPAWN_DELAY_MS: 1500   // 両端が塞がれバーが空のときのセーフティスポーン待機時間（ms）
};

// ==========================================
// 5. 容器（底面角カット）の設定
// ==========================================
export const CONTAINER = {
    CORNER_CUT_SIZE: 44           // 容器底面の左右45度角カットのサイズ（px）
};

// ==========================================
// 6. 上部バンパー（危険判定スイッチ）の設定
// ==========================================
export const BUMPER = {
    WIDTH: 16,                    // 壁から飛び出る厚み（かまぼこ型）
    HEIGHT_RATIO: 0.15,           // 画面高さに対するバンパーの高さ割合
    Y_RATIO: 0.34,                // 画面上でのY座標位置（フロートバーと非干渉）
    PUSH_THRESHOLD: 8,            // 壁側へこの距離以上押し込まれたら赤色(ON)判定
    MAX_PUSH: 14,                 // 壁側へ押し込める最大距離（px）
    GAME_OVER_HOLD_MS: 200        // 左右同時押し込みがゲームオーバー確定する継続時間（ms）
};

// ==========================================
// 7. 演出およびスコア計算用パラメータ
// ==========================================
export const EFFECTS = {
    MERGE_EXPAND_FRAMES: 10,      // 合体時にぷるんと膨張させるフレーム数
    MERGE_EXPAND_SCALE: 1.15,     // 膨張時の最大スケール倍率
    MERGE_BASE_DELAY_MS: 45,      // 最小ゼリーの合体保護ディレイ（ms）
    MERGE_AREA_DELAY_FACTOR: 0.004 // 面積に応じて保護時間を少し延ばす係数
};

export const SCORE = {
    COMBO_MULTIPLIER: 1.5,        // 互換維持用（v3.0の本家仕様では盤面有効値総和スコアを使用）
    CHAIN_WINDOW_MS: 1000         // 連鎖合体（音程上昇演出用）の判定ウィンドウ（ms）
};

// ==========================================
// 8. UI・GRAVITY自動レイアウト環境設定
// ==========================================
export const UI = {
    SAFE_TOP_HEADER_PX: 52,       // GRAVITY上部ネイティブボタン帯（左<・右アイコン群）回避用ヘッダー高さ
    SAFE_BOTTOM_PX: 215,          // GRAVITYネイティブ招待ボタンとの干渉を防ぐための下部余白
    CANVAS_MARGIN_X: 6,           // 画面左右の最小余白（px）
    CANVAS_MARGIN_BOTTOM: 8,      // 画面下端の最小余白（px）
    MAX_DPR: 2,                   // Retina高精細描画の上限ピクセル比（負荷対策）
    DROP_COOLDOWN_MS: 220,        // 軽快に連続操作できる短い発射クールダウン（ms）
    QUEUE_SIZE: 4                 // 互換維持用
};