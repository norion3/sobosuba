/**
 * constants.js
 * @version v5.0 (Final Overhaul & Refactoring Step 1)
 * @changes
 *   - 本家実機画像実測に基づくサイズ成長カーブ（r=21〜170px、公比約1.15、面積回収約34%）および本家カラーパレット（1〜32768）へ刷新
 *   - 等周不等式の罠を回避し美しい角丸多角形密着を実現するため、超低摩擦（FRICTION: 0.025）・皮バネの遊び（SKIN_STIFFNESS: 0.22）・1つ飛ばし曲げ剛性強化（BEND_STIFFNESS: 0.09）・内圧強化（SOFTBODY_PRESSURE: 0.00125）・下段弱形状保持定数（SHAPE_MATCH_STIFFNESS）を定義
 *   - 上段フロートバーの「横長カプセル（ピル）形状」圧縮定数（CHANNEL_HALF_HEIGHT: 21 / CHANNEL_COMPRESSION_STIFFNESS / MORPH_DURATION_MS: 160 / RECATCH_MORPH_DURATION_MS: 140）を追加
 *   - 6つの「動作の間」タイムライン定数（合体前吸い付き55〜140ms・Grow-In 0.78倍→1.08倍オーバーシュート・面積比例保護70〜220ms・ホップ滞空重力0.62倍・スポーナー間隔260ms・バンパー確定250ms＆ゲームオーバー余韻550ms）を定義
 *   - 2.5D飛び越えレーン方式ホップおよびバンパー誤爆防止のための衝突ビットマスク定数 COLLISION_CATEGORY（WALL / BUMPER / FIELD_JELLY / BAR_FLOATING / BAR_HOPPING）を新規追加
 * 
 * sobosuba風パズルの物理パラメータ、ゼリーの定義、UIセーフエリア等の定数モジュール
 * v5.0改修対象モジュールから絶対パス（/sobosuba/constants.js?v=5）でインポートして使用されます。
 */

// ==========================================
// 1. 空間・基本サイズ設定
// ==========================================
export const GAME_WIDTH = 420;
export const GAME_HEIGHT = 700;
export const WALL_THICKNESS = 60;
export const DROP_Y = 60;

// ==========================================
// 1.5 衝突カテゴリ定義（2.5D飛び越えレーン ＆ バンパー誤爆防止）
// ==========================================
export const COLLISION_CATEGORY = {
    WALL:         0x0001, // 容器の壁・天井・床・45度スロープ（全ゼリーと衝突）
    BUMPER:       0x0002, // 左右の半円バンパー（FIELD_JELLY のみと衝突しホップ誤爆ゼロ）
    FIELD_JELLY:  0x0004, // 下段フィールド内の通常ゼリー
    BAR_FLOATING: 0x0008, // 上段フロートバー上で待機中の横長カプセルゼリー
    BAR_HOPPING:  0x0010  // 上段飛び越えホップ飛行中（壁・天井のみ反射し他の待機ゼリーを通過）
};

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
            1:     '#ff2a4b', // ビビッドレッド
            2:     '#ffeb1a', // レモンイエロー
            4:     '#42f52a', // ネオングリーン
            8:     '#2df0a8', // ミントグリーン
            16:    '#2d8cff', // スカイブルー
            32:    '#9d4dff', // ビビッドパープル
            64:    '#ff2e93', // ショッキングピンク
            128:   '#ff6b1a', // オレンジ
            256:   '#d9f52a', // ライムイエロー
            512:   '#39f53d', // ブライトグリーン
            1024:  '#3be8ff', // ネオンシアン
            2048:  '#3366ff', // コバルトブルー
            4096:  '#d93bff', // マゼンタパープル
            8192:  '#ff2468', // クリムゾンピンク
            16384: '#ffa524', // ゴールデンオレンジ
            32768: '#9cff33'  // ライトグリーン（理論到達枠）
        }
    }
};

export const ACTIVE_THEME = COLOR_THEMES.default;

// 本家実機画像実測に基づくサイズ成長カーブ（公比約1.15・2個合体で約34%空間回収）
// 16384（直径300px）もバンパー有効幅（388px）内に余裕を持って収容しつつ本家同等の密度を実現
export const JELLY_CONFIG = {
    1:     { color: ACTIVE_THEME.colors[1],     radius: 21,   text: ACTIVE_THEME.text, particles: 14 },
    2:     { color: ACTIVE_THEME.colors[2],     radius: 24,   text: ACTIVE_THEME.text, particles: 14 },
    4:     { color: ACTIVE_THEME.colors[4],     radius: 27.5, text: ACTIVE_THEME.text, particles: 16 },
    8:     { color: ACTIVE_THEME.colors[8],     radius: 31.5, text: ACTIVE_THEME.text, particles: 16 },
    16:    { color: ACTIVE_THEME.colors[16],    radius: 36.5, text: ACTIVE_THEME.text, particles: 18 },
    32:    { color: ACTIVE_THEME.colors[32],    radius: 42,   text: ACTIVE_THEME.text, particles: 18 },
    64:    { color: ACTIVE_THEME.colors[64],    radius: 48.5, text: ACTIVE_THEME.text, particles: 20 },
    128:   { color: ACTIVE_THEME.colors[128],   radius: 56,   text: ACTIVE_THEME.text, particles: 20 },
    256:   { color: ACTIVE_THEME.colors[256],   radius: 64.5, text: ACTIVE_THEME.text, particles: 22 },
    512:   { color: ACTIVE_THEME.colors[512],   radius: 74,   text: ACTIVE_THEME.text, particles: 22 },
    1024:  { color: ACTIVE_THEME.colors[1024],  radius: 85,   text: ACTIVE_THEME.text, particles: 24 },
    2048:  { color: ACTIVE_THEME.colors[2048],  radius: 98,   text: ACTIVE_THEME.text, particles: 24 },
    4096:  { color: ACTIVE_THEME.colors[4096],  radius: 113,  text: ACTIVE_THEME.text, particles: 26 },
    8192:  { color: ACTIVE_THEME.colors[8192],  radius: 130,  text: ACTIVE_THEME.text, particles: 26 },
    16384: { color: ACTIVE_THEME.colors[16384], radius: 150,  text: ACTIVE_THEME.text, particles: 28 },
    32768: { color: ACTIVE_THEME.colors[32768], radius: 170,  text: ACTIVE_THEME.text, particles: 28 }
};

// ==========================================
// 3. 物理演算（Matter.js SUBSTEPS=4 正規化 ＋ 角丸多角形密着ソフトボディ）パラメータ
// ==========================================
export const PHYSICS = {
    GRAVITY_Y: 1.15,              // 重力
    SUBSTEPS: 4,                  // 1フレームあたりの物理サブステップ分割数
    RESTITUTION: 0.25,            // 反発係数（ボヨ〜ンと心地よく弾む弾性）
    FRICTION: 0.025,              // 超低摩擦（狭い隙間へニュルンと滑り込む本家の手触り）
    FRICTION_STATIC: 0.015,       // 静止摩擦も極めて低く設定
    FRICTION_AIR: 0.004,          // 低い空気抵抗（軽快な揺れを維持）

    // 隙間ゼロ高密度・中空ビーズリング（等周不等式回避の黄金比）
    DENSITY_PARTICLE: 0.0012,     // 外周ビーズ剛体の密度
    BEAD_RADIUS_RATIO: 0.25,      // 全体半径に対する外周ビーズ半径の基準比率
    BEAD_MIN_OVERLAP_RATIO: 1.35, // 隣接ビーズ直径 >= 1.35 * 辺長 を保証する隙間ゼロ比率
    SKIN_STIFFNESS: 0.22,         // わずかな伸縮（遊び）を許容し丸く固まらない皮の張り剛性
    BEND_STIFFNESS: 0.09,         // シワ折れ・フック奇形を防ぐ1つ飛ばし曲げ拘束（強化）
    SOFTBODY_DAMPING: 0.02,       // SUBSTEPS=4 正規化済みの低バネ減衰

    // 力ベース内圧強化 ＆ 下段弱形状保持（Shape Matching）＆ 分散非侵入排斥
    PBD_AREA_STIFFNESS: 0.28,     // 補助的なPBD面積補正強度
    PBD_MAX_CORRECTION: 0.6,      // 他ゼリーやスロープ壁へめり込ませない極小位置補正上限（px/step）
    SOFTBODY_PRESSURE: 0.00125,   // 自重ペッタンコ餅を防ぎふっくら多角形密着を生む内部圧力係数
    SHAPE_MATCH_STIFFNESS: 0.00022, // 下段落下後のみ効く弱め形状保持（丸く固めず奇形崩壊だけ防止）
    INVERSION_AREA_RATIO: 0.28,   // 符号付き面積がこの比率未満になったら形状自動修復
    SOFTBODY_MIN_DIST_RATIO: 0.48,// 重心からの最小距離比率（ペシャンコ防止）
    ANTI_OVERLAP_STIFFNESS: 0.65, // 分散型 Point-in-Polygon 侵入ビーズ排斥強度
    ANTI_OVERLAP_MAX_PUSH: 4.0,   // 1サブステップあたりの最大排斥距離（px）
    MAX_PARTICLE_SPEED: 4.5,      // SUBSTEPS=4 正規化済み最大速度（px/substep ≒ 18px/frame）

    // 互換維持用
    DENSITY_CORE: 0.002,
    SOFTBODY_STIFFNESS: 0.04,
    SOFTBODY_PERIMETER_STIFFNESS: 0.22,

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
// 4. 上部フロートバー（横長カプセル待機・左右2本スポーナー・2.5D上段ホップ＆再吸着）の設定
// ==========================================
export const FLOAT_BAR = {
    Y: 112,                       // 上空アーチ空間（約110px）を確保したフロートバー中心Y座標
    MAX_COUNT: 5,                 // バー上に保持する目安最大ゼリー数
    PADDING_X: 24,                // 左右の壁からの余白
    LEFT_SPAWN_X: 46,             // 左側スポーナーの出現基準X座標
    RIGHT_SPAWN_X: 374,           // 右側スポーナーの出現基準X座標
    SPAWN_CLEARANCE_MARGIN: 6,    // スポーナー空き検知に必要な追加余白（px）
    SPAWN_ENTRY_VELOCITY: 0.55,   // SUBSTEPS=4 正規化済み（左右端から滑らかに中央へ入る初速）
    SPRING_STIFFNESS: 0.09,       // バーY高度へ保持する弾性フック強度
    PACK_FORCE: 0.00005,          // バー上で穏やかに中央寄りへ保つ微弱引力
    X_DAMPING: 0.986,             // 横方向の極低ダンピング（スルスル滑る本家挙動）
    Y_DAMPING: 0.88,              // 縦方向の揺れを抑えるダンピング
    SPAWN_DELAY_MS: 260,          // スポーナー供給の「ゲージの間」（ms）
    SAFETY_SPAWN_DELAY_MS: 1500,  // 両端閉塞かつバー空時のセーフティスポーン待機時間（ms）

    // 上段「横長カプセル（ピル）形状」圧縮 ＆ 発射／着地モーフィング定数
    CHANNEL_HALF_HEIGHT: 21,      // 上段待機時のフラット帯半高（全高約42px、4〜64が横長に伸びる）
    CHANNEL_COMPRESSION_STIFFNESS: 0.16, // フラット帯上下端へ収める柔らかな圧縮フック強度
    CAPSULE_MAX_HALF_WIDTH: 110,  // 上段カプセルの最大半幅上限（px）
    MORPH_DURATION_MS: 160,       // 発射時の「変身の間」（横長カプセル→円形リング復元時間・ms）
    RECATCH_MORPH_DURATION_MS: 140, // ホップ着地時の「着席の間」（円形→横長カプセル復帰時間・ms）

    // 上段タップ選択許容範囲（画面下部の誤タップ暴発を完全防止）
    TAP_SELECT_Y_MARGIN: 75,      // バー中心から上下この距離以内（Y <= FLOAT_BAR.Y + 75）のみ選択可
    TAP_SELECT_EXTRA_RADIUS: 28,  // 各ゼリー実幅・実高に加えるタップ許容マージン（px）

    // 2.5D 上段飛び越えホップ ＆ 自動再吸着（Bar-Hop & Re-Catch）定数
    HOP_TRIGGER_DY: -12,          // 上向きドラッグ（dy < -12）で上段飛び越えホップモードへ自動切替
    HOP_FORCE_MULTIPLIER: 0.026,  // ホップ発射時の初速係数（px/substep）
    HOP_MIN_UP_SPEED: 1.9,        // 隣の塊を確実に飛び越える最小上向き初速（px/substep）
    HOP_MAX_SPEED: 3.9,           // ホップ時の最大初速（px/substep）
    HOP_GRAVITY_SCALE: 0.62,      // 頂点にふわっとした滞空の間を作るホップ専用重力倍率
    HOP_MIN_AIR_MS: 115,          // 発射直後に即再吸着しないための最小滞空時間（ms）
    HOP_RECATCH_Y_MIN: 92,        // 下降中にバーへ自動再吸着するY範囲下限
    HOP_RECATCH_Y_MAX: 138,       // 下降中にバーへ自動再吸着するY範囲上限
    HOP_MAX_AIR_MS: 2200,         // 万が一長時間空中に留まった際の安全タイムアウト（ms）
    HOP_POPUP_MAX_SCALE: 1.14,    // ホップ飛行中に手前へ飛び越える立体感の最大拡大率（+14%）
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
    GAME_OVER_HOLD_MS: 250        // 誤爆ゼロの左右同時押し込み確定時間（ms）
};

// ==========================================
// 7. 演出およびスコア計算用パラメータ（6つの「動作の間」同期）
// ==========================================
export const EFFECTS = {
    MERGE_EXPAND_FRAMES: 10,      // 合体時にぷるんと膨張させるフレーム数
    MERGE_EXPAND_SCALE: 1.12,     // 膨張時の最大スケール倍率
    MERGE_ANTICIPATION_MIN_MS: 55,// 合体前の「吸い付きの間」最小時間（ms）
    MERGE_ANTICIPATION_MAX_MS: 140,// 合体前の「吸い付きの間」最大時間（ms）
    MERGE_GROW_START_SCALE: 0.78, // 合体時の縮小スポーン開始倍率（重なり・絡み合い根絶）
    MERGE_GROW_DURATION_MS: 150,  // 縮小スポーンから Ease-Out-Back で定着する時間（ms）
    MERGE_GROW_OVERSHOOT: 1.08,   // 成長完了直前にわずかにボヨンと弾むオーバーシュート倍率
    MERGE_PROTECT_MIN_MS: 70,     // 合体後の面積比例保護時間下限（階段連鎖の間・ms）
    MERGE_PROTECT_MAX_MS: 220,    // 合体後の面積比例保護時間上限（ms）
    MERGE_BASE_DELAY_MS: 55,      // 最小ゼリーの合体保護ディレイ基準（ms）
    MERGE_AREA_DELAY_FACTOR: 0.0045 // 面積に応じて吸い付き・保護時間を延ばす係数
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
    GAME_OVER_DELAY_MS: 550,      // ゲームオーバー確定時の「余韻の間」（ms）
    QUEUE_SIZE: 4                 // 互換維持用
};