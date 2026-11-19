/**
 * constants.js
 * @version v4.0 (Final Overhaul Step 1)
 * @changes
 *   - SUBSTEPS=4 に合わせた物理速度上限・発射初速係数・バネ剛性・衝撃波インパルス・衝突音速度閾値を完全正規化
 *   - 隙間ゼロ高密度ビーズ比率（BEAD_RADIUS_RATIO / BEAD_MIN_OVERLAP_RATIO）と、16384までバンパー幅内に快適収容する新サイズ成長カーブ（基準半径16px）へ調整
 *   - ソフトボディ間非侵入（Anti-Overlap）排斥ソルバー、力ベース内圧主軸化＆PBD上限抑制（0.6px/step）、合体時縮小スポーン→膨張成長（Grow-In）用定数を追加
 *   - 上段飛び越えホップ＆自動再吸着のため、上空アーチ空間を確保（FLOAT_BAR.Y: 112 / BUMPER.Y_RATIO: 0.39）し、ホップ発動閾値・ホップ重力・再吸着定数および上段タップ選択許容範囲を追加
 *   - 32・2048 の黒文字視認性を高めるビビッドカラー調整、未合体文字の可読性向上、ゲームオーバー余韻ウェイト（500ms）、通常ブラウザ用上部余白定数を追加
 * 
 * sobosuba風パズルの物理パラメータ、ゼリーの定義、UIセーフエリア等の定数モジュール
 * 全モジュールから絶対パス（/sobosuba/constants.js?v=4）でインポートして使用されます。
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
export const COLOR_THEMES = {
    default: {
        name: 'default',
        background: '#080808',
        containerBg: '#080808',
        wallStroke: '#3a3a3a',
        cornerFill: '#262626',
        outline: '#000000',
        text: '#000000',
        unmergedTextAlpha: 0.56,      // モバイル小画面でも判読しやすい未合体文字透明度
        colors: {
            1:     '#ff1e46', // ビビッドレッド
            2:     '#fffa15', // レモンイエロー
            4:     '#39ff14', // ネオングリーン
            8:     '#00fa9a', // ミントグリーン
            16:    '#00bfff', // スカイブルー
            32:    '#b84dff', // 視認性改善ビビッドパープル（黒文字高コントラスト）
            64:    '#ff00ff', // マゼンタ
            128:   '#ff6600', // オレンジ
            256:   '#ccff00', // ライムイエロー
            512:   '#e0ffff', // ペールミント(白系)
            1024:  '#ff1493', // ディープピンク
            2048:  '#3b82ff', // 視認性改善コバルトブルー（黒文字高コントラスト）
            4096:  '#da70d6', // ライトパープル
            8192:  '#ff007f', // ローズレッド
            16384: '#00ffd5'  // シアンネオン
        }
    }
};

export const ACTIVE_THEME = COLOR_THEMES.default;

// 16384（直径304px）でもバンパー有効幅（388px）内に余裕を持って収容する新サイズ成長カーブ
// かつ2個合体時の面積回収（約1/3省スペース化）を維持し、高密度ビーズ数（14〜26）で隙間ゼロ外殻を構築
export const JELLY_CONFIG = {
    1:     { color: ACTIVE_THEME.colors[1],     radius: 16,   text: ACTIVE_THEME.text, particles: 14 },
    2:     { color: ACTIVE_THEME.colors[2],     radius: 19,   text: ACTIVE_THEME.text, particles: 14 },
    4:     { color: ACTIVE_THEME.colors[4],     radius: 22.5, text: ACTIVE_THEME.text, particles: 15 },
    8:     { color: ACTIVE_THEME.colors[8],     radius: 26.5, text: ACTIVE_THEME.text, particles: 16 },
    16:    { color: ACTIVE_THEME.colors[16],    radius: 31,   text: ACTIVE_THEME.text, particles: 16 },
    32:    { color: ACTIVE_THEME.colors[32],    radius: 36.5, text: ACTIVE_THEME.text, particles: 17 },
    64:    { color: ACTIVE_THEME.colors[64],    radius: 43,   text: ACTIVE_THEME.text, particles: 18 },
    128:   { color: ACTIVE_THEME.colors[128],   radius: 50.5, text: ACTIVE_THEME.text, particles: 19 },
    256:   { color: ACTIVE_THEME.colors[256],   radius: 59,   text: ACTIVE_THEME.text, particles: 20 },
    512:   { color: ACTIVE_THEME.colors[512],   radius: 69,   text: ACTIVE_THEME.text, particles: 21 },
    1024:  { color: ACTIVE_THEME.colors[1024],  radius: 81,   text: ACTIVE_THEME.text, particles: 22 },
    2048:  { color: ACTIVE_THEME.colors[2048],  radius: 95,   text: ACTIVE_THEME.text, particles: 23 },
    4096:  { color: ACTIVE_THEME.colors[4096],  radius: 111,  text: ACTIVE_THEME.text, particles: 24 },
    8192:  { color: ACTIVE_THEME.colors[8192],  radius: 130,  text: ACTIVE_THEME.text, particles: 26 },
    16384: { color: ACTIVE_THEME.colors[16384], radius: 152,  text: ACTIVE_THEME.text, particles: 26 }
};

// ==========================================
// 3. 物理演算（Matter.js SUBSTEPS=4 正規化 ＋ 非侵入中空ビーズリング）パラメータ
// ==========================================
export const PHYSICS = {
    GRAVITY_Y: 1.15,              // 重力
    SUBSTEPS: 4,                  // 1フレームあたりの物理サブステップ分割数
    RESTITUTION: 0.24,            // 反発係数（ボヨンと心地よく弾む弾性）
    FRICTION: 0.03,               // 超低摩擦（粘り気を無くし、狭い隙間へニュルンと滑り込む）
    FRICTION_STATIC: 0.02,        // 静止摩擦も極めて低く設定
    FRICTION_AIR: 0.004,          // 低い空気抵抗（SUBSTEPS=4 時の軽快な揺れを維持）

    // 隙間ゼロ高密度・中空ビーズリング関連パラメータ（SUBSTEPS=4 正規化済み）
    DENSITY_PARTICLE: 0.0012,     // 外周ビーズ剛体の密度
    BEAD_RADIUS_RATIO: 0.26,      // 全体半径に対する外周ビーズ半径の基準比率
    BEAD_MIN_OVERLAP_RATIO: 1.35, // 隣接ビーズ直径 >= 1.35 * 辺長 を保証する隙間ゼロ比率
    SKIN_STIFFNESS: 0.24,         // SUBSTEPS=4 で過硬化しない皮の張りバネ剛性
    BEND_STIFFNESS: 0.045,        // SUBSTEPS=4 で流動性を損なわない1つ飛ばし曲げ拘束
    SOFTBODY_DAMPING: 0.02,       // SUBSTEPS=4 正規化済みの低バネ減衰

    // 力ベース内圧主軸 ＆ PBD極小上限 ＆ ソフトボディ間非侵入排斥ソルバー
    PBD_AREA_STIFFNESS: 0.25,     // 補助的なPBD面積補正強度
    PBD_MAX_CORRECTION: 0.6,      // 他ゼリーやスロープ壁へめり込ませない極小位置補正上限（px/step）
    SOFTBODY_PRESSURE: 0.00085,   // 主軸となる力ベース内部圧力係数
    INVERSION_AREA_RATIO: 0.25,   // 符号付き面積がこの比率未満になったら形状自動修復
    SOFTBODY_MIN_DIST_RATIO: 0.45,// 重心からの最小距離比率（ペシャンコ防止）
    ANTI_OVERLAP_STIFFNESS: 0.72, // Point-in-Polygon 侵入ビーズを最近傍エッジ外へ押し戻す排斥強度
    ANTI_OVERLAP_MAX_PUSH: 4.5,   // 1サブステップあたりの最大排斥距離（px）
    MAX_PARTICLE_SPEED: 4.5,      // SUBSTEPS=4 正規化済み最大速度（px/substep ≒ 18px/frame）

    // 互換維持用
    DENSITY_CORE: 0.002,
    SOFTBODY_STIFFNESS: 0.04,
    SOFTBODY_PERIMETER_STIFFNESS: 0.24,

    // バンパー関連（SUBSTEPS=4 正規化済み）
    BUMPER_STIFFNESS: 0.015,      // SUBSTEPS=4 時にゼリー圧力で自然に押し込めるバネ剛性
    BUMPER_DAMPING: 0.05,         // バンパーのバネ減衰

    // 順方向ダイレクトエイム関連（SUBSTEPS=4 正規化済み・360度エイム解放）
    SLINGSHOT_FORCE_MULTIPLIER: 0.00015, // 互換用
    SLINGSHOT_MAX_DRAG: 150,             // 互換用
    AIM_FORCE_MULTIPLIER: 0.028,         // 通常下段ショット初速係数（150pxドラッグで4.2px/substep）
    AIM_MAX_DRAG: 150,                   // 最大ドラッグ距離（px）
    AIM_CANCEL_RADIUS: 22,               // 指揺れ誤爆を防ぐキャンセル判定半径（px）

    // 合体時膨張インパルス ＆ 衝突音速度閾値（SUBSTEPS=4 正規化済み）
    MERGE_RADIAL_IMPULSE: 1.45,          // フィールド内合体時の周囲外向き速度インパルス（px/substep）
    MERGE_RADIAL_FORCE: 0.012,           // 互換用
    COLLIDE_SOUND_MIN_SPEED: 0.55,       // 衝突音を鳴らす最小相対速度（px/substep ≒ 2.2px/frame）
    COLLIDE_SOUND_MAX_SPEED: 3.0         // 衝突音最大強度となる相対速度（px/substep）
};

// ==========================================
// 4. 上部フロートバー（上空アーチ空間・左右2点スポーナー・上段ホップ＆再吸着）の設定
// ==========================================
export const FLOAT_BAR = {
    Y: 112,                       // 上空アーチ空間（約110px）を確保したフロートバー中心Y座標
    MAX_COUNT: 5,                 // バー上に保持する目安最大ゼリー数
    PADDING_X: 26,                // 左右の壁からの余白
    LEFT_SPAWN_X: 44,             // 左側スポーナーの出現基準X座標
    RIGHT_SPAWN_X: 376,           // 右側スポーナーの出現基準X座標
    SPAWN_CLEARANCE_MARGIN: 6,    // スポーナー空き検知に必要な追加余白（px）
    SPAWN_ENTRY_VELOCITY: 0.55,   // SUBSTEPS=4 正規化済み（左右端から滑らかに中央へ入る初速）
    SPRING_STIFFNESS: 0.09,       // バーY高度へ保持する弾性フック強度
    PACK_FORCE: 0.00005,          // バー上で穏やかに中央寄りへ保つ微弱引力
    X_DAMPING: 0.985,             // 横方向の極低ダンピング（スルスル滑る本家挙動）
    Y_DAMPING: 0.88,              // 縦方向の揺れを抑えるダンピング
    SPAWN_DELAY_MS: 280,          // スポーナー補充の最小間隔（ms）
    SAFETY_SPAWN_DELAY_MS: 1500,  // 両端閉塞かつバー空時のセーフティスポーン待機時間（ms）

    // 上段タップ選択許容範囲（画面下部の誤タップ暴発を完全防止）
    TAP_SELECT_Y_MARGIN: 75,      // バー中心から上下この距離以内（Y <= FLOAT_BAR.Y + 75）のみ選択可
    TAP_SELECT_EXTRA_RADIUS: 28,  // 各ゼリー半径に加えるタップ許容マージン（px）

    // 上段飛び越えホップ ＆ 自動再吸着（Bar-Hop & Re-Catch）定数
    HOP_TRIGGER_DY: -12,          // 上向きドラッグ（dy < -12）で上段飛び越えホップモードへ自動切替
    HOP_FORCE_MULTIPLIER: 0.026,  // ホップ発射時の初速係数（px/substep）
    HOP_MIN_UP_SPEED: 1.85,       // 隣の塊を確実に飛び越える最小上向き初速（px/substep）
    HOP_MAX_SPEED: 3.9,           // ホップ時の最大初速（px/substep）
    HOP_GRAVITY_SCALE: 0.65,      // ホップ中の専用重力倍率（緩やかな山なりアーチ軌道）
    HOP_MIN_AIR_MS: 110,          // 発射直後に即再吸着しないための最小滞空時間（ms）
    HOP_RECATCH_Y_MIN: 92,        // 下降中にバーへ自動再吸着するY範囲下限
    HOP_RECATCH_Y_MAX: 138,       // 下降中にバーへ自動再吸着するY範囲上限
    HOP_MAX_AIR_MS: 2200,         // 万が一長時間空中に留まった際の安全タイムアウト（ms）
    BAR_MERGE_MAX_VALUE: 512      // 下段巨大ゼリーの吸い上げを防ぐバー上留まり合体の上限数値
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
    Y_RATIO: 0.39,                // FLOAT_BAR.Y=112 と十分な安全距離を保つY座標位置（39%）
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
    MERGE_GROW_START_SCALE: 0.75, // 合体時の縮小スポーン開始倍率（重なり・絡み合い根絶）
    MERGE_GROW_DURATION_MS: 150,  // 縮小スポーンから本来の目標面積へ滑らかに成長する時間（ms）
    MERGE_BASE_DELAY_MS: 45,      // 最小ゼリーの合体保護ディレイ（ms）
    MERGE_AREA_DELAY_FACTOR: 0.004 // 面積に応じて保護時間を少し延ばす係数
};

export const SCORE = {
    COMBO_MULTIPLIER: 1.5,        // 互換維持用（本家仕様では盤面有効値総和スコアを使用）
    CHAIN_WINDOW_MS: 1000         // 連鎖合体（音程上昇演出用）の判定ウィンドウ（ms）
};

// ==========================================
// 8. UI・GRAVITY自動レイアウト環境設定
// ==========================================
export const UI = {
    SAFE_TOP_HEADER_PX: 52,       // GRAVITYアプリ内上部ネイティブボタン帯回避用ヘッダー高さ
    SAFE_TOP_HEADER_BROWSER_PX: 8,// 通常ブラウザ表示時のコンパクトな上部ヘッダー余白
    SAFE_BOTTOM_PX: 215,          // GRAVITYネイティブ招待ボタンとの干渉を防ぐための下部余白
    CANVAS_MARGIN_X: 6,           // 画面左右の最小余白（px）
    CANVAS_MARGIN_BOTTOM: 8,      // 画面下端の最小余白（px）
    MAX_DPR: 2,                   // Retina高精細描画の上限ピクセル比（負荷対策）
    DROP_COOLDOWN_MS: 220,        // 軽快に連続操作できる短い発射クールダウン（ms）
    GAME_OVER_DELAY_MS: 500,      // ゲームオーバー確定時の納得感ある余韻ウェイト（ms）
    QUEUE_SIZE: 4                 // 互換維持用
};