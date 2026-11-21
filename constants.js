/**
 * constants.js
 * @version v8.6 (Plan B: +6% Size Scaling, Settled Vertical Stretch Constants & Upper Channel Sync - Phase 1)
 * @changes
 *   - 難易度を少し引き上げるため JELLY_CONFIG 全16ティアの半径を約 +6%（面積 +12.4%）拡大（1: 25.5 〜 32768: 176.0）
 *   - 小〜中塊耐圧ブースト基準半径 PHYSICS.SMALL_BOOST_REF_RADIUS を新 128 半径に合わせて 58.5 → 62.0 へ同期
 *   - 上段バー上の 1（半径 25.5）真円維持および終盤横幅余裕確保のため FLOAT_BAR.CHANNEL_HALF_HEIGHT を 25 → 26 へ同期
 *   - 下段で動きが落ち着いた塊のみ自然に縦方向へ伸びる静止時縦ストレッチ力場定数（PHYSICS.SETTLE_STRETCH_SPEED_THRESHOLD / SETTLE_STRETCH_RESET_SPEED / SETTLE_STRETCH_DELAY_MS / SETTLE_STRETCH_RAMP_MS / SETTLE_STRETCH_TARGET_ASPECT / SETTLE_STRETCH_ASPECT_SPAN / SETTLE_STRETCH_FORCE_Y / SETTLE_STRETCH_FORCE_X_RATIO）を新設
 * 
 * sobosuba風パズルの物理パラメータ、ゼリーの定義、UIセーフエリア等の定数モジュール
 * v7.x/v8.x改修対象モジュールから絶対パス（/sobosuba/constants.js?v=7）でインポートして使用されます。
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
        unmergedTextAlpha: 0.72,      // 潰れた状態でも一目で読める未合体文字透明度
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

// 内幅404px（外枠8px考慮）へ最適化したサイズ成長カーブ（案B: 半径約+6%拡大・空間回収率 34.1%〜37.2% 統一）
// 細密ビーズ数（16〜30個）により角丸多角形への液体的な追従性を高める
export const JELLY_CONFIG = {
    1:     { color: ACTIVE_THEME.colors[1],     radius: 25.5,  text: ACTIVE_THEME.text, particles: 16 },
    2:     { color: ACTIVE_THEME.colors[2],     radius: 29.0,  text: ACTIVE_THEME.text, particles: 16 },
    4:     { color: ACTIVE_THEME.colors[4],     radius: 33.0,  text: ACTIVE_THEME.text, particles: 18 },
    8:     { color: ACTIVE_THEME.colors[8],     radius: 37.0,  text: ACTIVE_THEME.text, particles: 18 },
    16:    { color: ACTIVE_THEME.colors[16],    radius: 42.0,  text: ACTIVE_THEME.text, particles: 20 },
    32:    { color: ACTIVE_THEME.colors[32],    radius: 47.5,  text: ACTIVE_THEME.text, particles: 20 },
    64:    { color: ACTIVE_THEME.colors[64],    radius: 54.5,  text: ACTIVE_THEME.text, particles: 22 },
    128:   { color: ACTIVE_THEME.colors[128],   radius: 62.0,  text: ACTIVE_THEME.text, particles: 22 },
    256:   { color: ACTIVE_THEME.colors[256],   radius: 71.0,  text: ACTIVE_THEME.text, particles: 24 },
    512:   { color: ACTIVE_THEME.colors[512],   radius: 81.0,  text: ACTIVE_THEME.text, particles: 24 },
    1024:  { color: ACTIVE_THEME.colors[1024],  radius: 93.0,  text: ACTIVE_THEME.text, particles: 26 },
    2048:  { color: ACTIVE_THEME.colors[2048],  radius: 106.0, text: ACTIVE_THEME.text, particles: 26 },
    4096:  { color: ACTIVE_THEME.colors[4096],  radius: 121.0, text: ACTIVE_THEME.text, particles: 28 },
    8192:  { color: ACTIVE_THEME.colors[8192],  radius: 138.0, text: ACTIVE_THEME.text, particles: 28 },
    16384: { color: ACTIVE_THEME.colors[16384], radius: 157.0, text: ACTIVE_THEME.text, particles: 30 },
    32768: { color: ACTIVE_THEME.colors[32768], radius: 176.0, text: ACTIVE_THEME.text, particles: 30 }
};

// ==========================================
// 3. 物理演算（Matter.js SUBSTEPS=4 正規化 ＋ 軽気体バルーン・ソフトボディ）パラメータ
// ==========================================
export const PHYSICS = {
    GRAVITY_Y: 0.66,              // 空中落下テンポと着地後ウェイト・オフロードを両立する基準重力
    SETTLED_GRAVITY_SCALE: 0.38,  // 着地定着後の荷重伝達カット係数（下段への圧潰荷重を大幅に軽減）
    SETTLED_FALL_SPEED_START: 0.45, // 空洞落下開始時にウェイト・オフロード解除を始める下向き速度閾値（px/frame）
    SETTLED_FALL_SPEED_FULL: 1.6,   // 下向き落下がこの速度へ達したら通常重力100%へ完全復帰する速度閾値（px/frame）
    SUBSTEPS: 4,                  // 1フレームあたりの物理サブステップ分割数
    RESTITUTION: 0.12,            // 跳ね返りすぎを抑え、隙間へ押し込む力へ変換する低反発係数
    FRICTION: 0.004,              // 塊と塊の隙間へスルスル潜り込む極低摩擦
    FRICTION_STATIC: 0.004,       // 静止摩擦も極低に設定し、くさび進入と周囲連動を促進
    FRICTION_AIR: 0.0012,         // 極低空気抵抗（SUBSTEPS=4 での4重失速を防ぎ一直線弾道＆揺れを維持）

    // 隙間ゼロ高密度・細密中空ビーズリング（柔軟性＋質量スケーリング）
    DENSITY_PARTICLE: 0.0012,     // 基準半径（25.5px）における外周ビーズ剛体の密度
    DENSITY_SCALE_EXP: 1.45,      // サイズ間の1ビーズ質量を均等化し、大塊による小塊圧潰を防ぐ密度スケーリング指数
    BEAD_RADIUS_RATIO: 0.18,      // 全体半径に対する細密外周ビーズ半径の基準比率
    BEAD_MIN_OVERLAP_RATIO: 1.35, // 隣接ビーズ直径 >= 1.35 * 辺長 を保証する隙間ゼロ比率
    SKIN_STIFFNESS: 0.325,        // 上段待機・ホップ基準：流動感とくびれ・奇形防止を両立する皮の張り剛性
    BEND_STIFFNESS: 0.17,         // 上段待機・ホップ基準：密着変形とフック・くびれ奇形根絶を両立する1つ飛ばし曲げ拘束
    SOFTBODY_DAMPING: 0.02,       // SUBSTEPS=4 正規化済みの低バネ減衰

    // PBD位置ワープ・真円形状保持の完全撤廃 ＋ 早期立ち上がりガス内圧 ＋ 体積粘性
    TARGET_AREA_RATIO: 1.02,      // 上段保護を維持しつつ体積をしっかり保つ目標面積比
    PBD_AREA_STIFFNESS: 0,        // 永久微振動の原因となるPBD位置ワープを完全撤廃
    PBD_MAX_CORRECTION: 0,        // PBD位置ワープ上限0（純粋な力ベース内圧へ完全移行）
    SOFTBODY_PRESSURE: 0.00415,   // 上段待機・ホップ基準の力ベース内部圧力係数
    PRESSURE_NONLINEAR_GAIN: 14.5,// 面積圧縮時にガスらしい非圧縮性を発揮する非線形バルク反発係数
    PRESSURE_NONLINEAR_THRESHOLD: 0.055, // 面積5.5%圧縮から素早くガス圧反発が立ち上がる圧縮率閾値
    PRESSURE_RATIO_MAX: 7.5,      // 陽的積分安定性を守りつつ多層底層圧壊を防ぐ圧力比上限クランプ
    BULK_DAMPING: 0.00086,        // 上段待機・ホップ基準の半径方向ビビリ振動吸収用体積粘性
    SHAPE_MATCH_STIFFNESS: 0,     // 柔軟性を阻害する真円への記憶（Shape Matching）を完全撤廃
    INVERSION_AREA_RATIO: 0.18,   // 極限裏返り時のみ作動する穏健な自動修復閾値
    SOFTBODY_MIN_DIST_RATIO: 0.78,// 上段待機・ホップ基準の最小距離比率
    MIN_DIST_RESTORE_FORCE: 0.00068, // 上段待機・ホップ基準の最小距離復元力係数

    // 空中落下 〜 着地・隙間進入直後の超液体モード定数（上段発射ゼリー限定・本家風のたわみ＆くさび進入解放）
    AIR_SKIN_STIFFNESS: 0.25,     // 空中・着地インパクト時の柔らかい皮の張り剛性
    AIR_BEND_STIFFNESS: 0.105,    // 空中・着地インパクト時の大胆なたわみと隙間進入を許容する曲げ拘束
    AIR_PRESSURE: 0.0037,         // 空中・着地インパクト時の柔軟な内部圧力係数
    AIR_BULK_DAMPING: 0.00040,    // 着地瞬間の波打ちを殺さない控えめな体積粘性
    AIR_MIN_DIST_RATIO: 0.64,     // 着地時のスクウォッシュ＆隙間潜り込みを解放する最小距離比率
    AIR_RESTORE_FORCE: 0.00028,   // 空中・着地インパクト時の穏やかな最小距離復元力係数
    LAND_SOFT_HOLD_MS: 180,       // 初着地後に隙間進入・柔軟インパクトを保持する時間（ms）
    LAND_FIRM_RAMP_MS: 420,       // ホールド後に下段定着へ Smoothstep 移行する時間（ms）
    LAND_FAILSAFE_MS: 2200,       // 軽重力壁バウンド経由の長滞空もカバーする安全着地フェイルセーフ時間（ms）

    // 下段定着・縦立ち上がり＆ガス圧主役の体積維持基準定数（128〜1024+ 基準・真円記憶なし）
    SETTLED_SKIN_STIFFNESS: 0.335,// 空いた上端を張りのあるドームにする下段皮剛性（128+ 基準）
    SETTLED_BEND_STIFFNESS: 0.135,// 奇形下限を守りつつ縦長ドーム・くびれ密着を解放する下段曲げ剛性（128+ 基準）
    SETTLED_PRESSURE: 0.00455,    // ガス圧主役で体積を保ち上へ押し出す下段内部圧力基準係数（128+ 基準）
    SETTLED_BULK_DAMPING: 0.00056,// 周囲への心地よい連動波紋を伝える下段体積粘性（128+ 基準）
    SETTLED_MIN_DIST_RATIO: 0.800,// 下段定着時の縦方向保護最小距離比率（128+ 基準）
    SETTLED_RESTORE_FORCE: 0.00072,// 下段定着時の縦方向保護復元力係数（128+ 基準）
    HORIZ_MIN_DIST_SCALE: 0.78,   // 下段横方向の最小距離ガード緩和倍率（横から挟まれて縦へ立ち上がる余地を解放）
    HORIZ_RESTORE_SCALE: 0.40,    // 下段横方向の復元力緩和倍率（極限自己交差だけ防ぎ自然な縦立ち上がりを許容）

    // 小〜中塊（1〜64）下段定着限定・連続耐圧補強定数（128以上および上段フロートバーは加算0）
    SMALL_BOOST_REF_RADIUS: 62.0,    // ブースト減衰の基準半径（新128以上で係数0.0）
    SMALL_SKIN_BOOST: 0.065,         // 最小塊（1）下段定着時の皮剛性加算量
    SMALL_BEND_BOOST: 0.095,         // 最小塊（1）下段定着時の曲げ剛性加算量（荷重軽減に合わせ柔らかさとぷっくり感を両立）
    SMALL_PRESSURE_MULT: 1.02,       // 最小塊（1）下段定着時の内圧・体積粘性倍率
    SMALL_RESTORE_MULT: 2.0,         // 最小塊（1）下段定着時の最小距離復元力倍率（荷重軽減に合わせ微緩和）
    SMALL_MIN_DIST_RATIO_BOOST: 0.050,// 最小塊（1）下段定着時の最小距離比率加算量

    // 静止時縦ストレッチ力場定数（下段定着後に動きが落ち着いた塊のみ自然に縦長へ伸びる・3ゾーン速度制御）
    SETTLE_STRETCH_SPEED_THRESHOLD: 0.75, // 落ち着き加算の重心速度上限（px/frame）
    SETTLE_STRETCH_RESET_SPEED: 1.35,     // 4倍速解除を発動する衝撃・移動速度閾値（px/frame）
    SETTLE_STRETCH_DELAY_MS: 180,         // 着地・衝突の余韻を保護するディレイ時間（ms）
    SETTLE_STRETCH_RAMP_MS: 750,          // Smoothstep で滑らかに立ち上がる時間（ms）
    SETTLE_STRETCH_TARGET_ASPECT: 1.26,   // 目標外縁縦横比（到達で自動停止）
    SETTLE_STRETCH_ASPECT_SPAN: 0.26,     // 目標縦横比へのフィードバックランプ幅
    SETTLE_STRETCH_FORCE_Y: 0.00150,      // 縦方向ストレッチ力係数
    SETTLE_STRETCH_FORCE_X_RATIO: 0.45,   // 横方向引き締め比率（縦力係数に対する比）

    // 周囲連動揺れ解放 ＆ 遅延適応的圧迫ダンピング（一定期間動き続けた後にピタッと静寂化）
    SETTLE_SPEED_THRESHOLD: 0.28, // 全体静止とみなす重心速度閾値（px/frame）
    SETTLE_DELAY_MS: 650,         // 衝撃後の周囲連動揺れを保護する遅延時間（ms）
    SETTLE_RAMP_MS: 650,          // 650ms→1300msへ滑らかにダンピングを立ち上げるランプ時間（ms）
    SETTLE_MAX_DAMPING: 0.86,     // 完全圧迫静止時の重心相対速度残存係数（1フレーム換算・14%減衰）
    SETTLE_REL_WAVE_THRESHOLD: 0.48, // 通常ジッターを無視しつつ衝撃波打ちだけを検知して静寂化を一時解除する相対速度閾値（px/frame）

    // 分散非侵入排斥ソルバー（微小侵入スロップによる下敷きジッター遮断）
    ANTI_OVERLAP_STIFFNESS: 0.68, // 分散型 Point-in-Polygon 侵入ビーズ排斥強度（深い食い込み防止）
    ANTI_OVERLAP_MAX_PUSH: 3.8,   // 1サブステップあたりの最大排斥距離（px）
    OVERLAP_SLOP: 0.35,           // 微小侵入（0.35px未満）を無視するデッドゾーン（px）
    MAX_PARTICLE_SPEED: 5.6,      // 互換維持用（合体衝撃波等の上限基準）
    MAX_PARTICLE_VX: 10.5,        // 落下中の横速度削れを防ぐ非トンネリング範囲内の水平最大速度（px/frame）
    MAX_PARTICLE_VY: 12.0,        // 下方向フルパワー着地の頭打ちを防ぎつつ1サブステップ最大3.00pxの安全圏を守る垂直最大速度（px/frame）

    // 互換維持用
    DENSITY_CORE: 0.002,
    SOFTBODY_STIFFNESS: 0.04,
    SOFTBODY_PERIMETER_STIFFNESS: 0.15,

    // バンパー関連（定着荷重軽減・質量均等化後の実効横力比0.59xに合わせた厳密同期）
    BUMPER_STIFFNESS: 0.0040,     // 積み上げ側圧で自然に押し込める同期済みバネ剛性
    BUMPER_DAMPING: 0.08,         // バンパーのバネ減衰
    BUMPER_DENSITY: 0.0026,       // バンパー質量を約5.07へ適正化し横ショット直撃誤爆防止と釣り合いを両立

    // 順方向ダイレクトエイム関連（SUBSTEPS=4 正規化済み・360度エイム解放）
    SLINGSHOT_FORCE_MULTIPLIER: 0.00015, // 互換用
    SLINGSHOT_MAX_DRAG: 150,             // 互換用
    AIM_FORCE_MULTIPLIER: 0.056,         // 端まで一直線に届く通常ショット初速係数
    AIM_MAX_DRAG: 120,                   // スマホ片手スワイプで最大威力を出しやすいドラッグ距離（px・上半円＆横軸上限）
    AIM_MAX_DRAG_DOWN: 170,              // 下方向限定で弱・中・強の明確な操作幅とパワーショットを解放する最大ドラッグ距離（px）
    AIM_CANCEL_RADIUS: 22,               // 指揺れ誤爆を防ぐキャンセル判定半径（px）

    // 合体時膨張インパルス ＆ 重心法線接近速度ベースの衝突音閾値
    MERGE_RADIAL_IMPULSE: 0.86,          // 定着重力（0.251）下でも浮き上がりを防ぎ心地よい波紋を伝える合体インパルス（px/frame）
    MERGE_RADIAL_FORCE: 0.012,           // 互換用
    COLLIDE_SOUND_MIN_SPEED: 0.65,       // 衝突音を鳴らす最小重心法線接近速度（px/frame）
    COLLIDE_SOUND_MAX_SPEED: 3.0,        // 衝突音最大強度となる相対速度（px/frame）
    COLLIDE_SOUND_PAIR_COOLDOWN_MS: 450  // 同一ゼリーペア間の衝突音連打を防ぐクールダウン（ms）
};

// ==========================================
// 4. 上部フロートバー（横長カプセル待機・左右2本スポーナー・天井非激突2.5Dホップ）の設定
// ==========================================
export const FLOAT_BAR = {
    Y: 108,                       // バンパー引き上げ（30%）と両立し上空空間を確保したバー中心Y座標
    MAX_COUNT: 5,                 // バー上に保持する目安最大ゼリー数
    PADDING_X: 26,                // 内壁8px＋バンパー18px面を回避し端落とし非干渉を保証する左右余白
    LEFT_SPAWN_X: 48,             // 左側スポーナーの出現基準X座標（内壁＋バンパー基準）
    RIGHT_SPAWN_X: 372,           // 右側スポーナーの出現基準X座標（内壁＋バンパー基準）
    SPAWN_CLEARANCE_MARGIN: 6,    // スポーナー空き検知に必要な追加余白（px）
    SPAWN_ENTRY_VELOCITY: 0.55,   // 左右端から滑らかに中央へ入る初速
    SPRING_STIFFNESS: 0.09,       // バーY高度へ保持する弾性フック強度
    PACK_FORCE: 0.00005,          // バー上で穏やかに中央寄りへ保つ微弱引力
    X_DAMPING: 0.986,             // 横方向の極低ダンピング（スルスル滑る本家挙動）
    Y_DAMPING: 0.945,             // 上段でもタプタプ揺れる液体感を残す縦方向ダンピング
    SPAWN_DELAY_MS: 260,          // スポーナー供給の「ゲージの間」（ms）
    SAFETY_SPAWN_DELAY_MS: 1500,  // 両端閉塞かつバー空時のセーフティスポーン待機時間（ms）

    // 斜め下ショット時の隣カプセル角引っ掛かり防止（AABB離脱までの一時すり抜け保護）
    LAUNCH_BAR_GRACE_MAX_MS: 220, // AABB離脱待ちすり抜け保護の安全上限時間（ms）
    LAUNCH_GRACE_MIN_DY: -2,      // 浅い角度の端狙いショットでも隣カプセル失速を防ぐ下向き発動条件（px）
    LAUNCH_GRACE_MIN_SLOPE: 0.22, // 真横当てバー上合体を保護する最小下向き勾配（dy >= 0.22 * |dx|）

    // 上段「横長カプセル（ピル）形状」圧縮 ＆ 発射／着地モーフィング定数
    CHANNEL_HALF_HEIGHT: 26,      // 1(25.5px)が真円のまま収まり4〜64が横長に伸びるフラット帯半高
    CHANNEL_COMPRESSION_STIFFNESS: 0.055, // 定規のような直線を避け、丸みとたわみのある液体感を残す圧縮強度
    CAPSULE_MAX_HALF_WIDTH: 110,  // 上段カプセルの最大半幅上限（px）
    MORPH_DURATION_MS: 160,       // 発射時の「変身の間」（横長カプセル→円形リング復元時間・ms）
    RECATCH_MORPH_DURATION_MS: 140, // ホップ着地時の「着席の間」（円形→横長カプセル復帰時間・ms）

    // 上段タップ選択許容範囲（画面下部の誤タップ暴発を完全防止）
    TAP_SELECT_Y_MARGIN: 75,      // バー中心から上下この距離以内（Y <= FLOAT_BAR.Y + 75）のみ選択可
    TAP_SELECT_EXTRA_RADIUS: 28,  // 各ゼリー実幅・実高に加えるタップ許容マージン（px）

    // 天井非激突 2.5D 上段飛び越えホップ ＆ セーフ・リキャッチ定数（Matter.js 0.20 px/frame 正規化済）
    HOP_TRIGGER_DY: -16,          // 横狙いショットの誤爆を防ぎつつ上向きドラッグでホップへ切替
    HOP_TRIGGER_SLOPE: 0.42,      // 横ショット帯のホップ誤爆を遮断する最小上向き勾配（-dy > |dx| * 0.42 ≒ 約23度）
    HOP_FORCE_MULTIPLIER: 0.026,  // 互換維持用
    HOP_MIN_UP_SPEED: 5.80,       // 天井非激突（上昇約47px）を保ち1個〜複数個を確実に飛び越える最小上向き初速（px/frame）
    HOP_MAX_UP_SPEED: 6.55,       // 天井非激突（上昇約60px）を保ち大ジャンプする最大上向き初速（px/frame）
    HOP_X_MULTIPLIER: 0.075,      // 1個飛び〜端から端まで思い通りに届く横方向初速係数
    HOP_INHERIT_VX: 0.2,          // 予測ドットとのズレを防ぐ控えめなバー横速度継承率
    HOP_MAX_SPEED: 11.5,          // 斜め強ホップの合成速度を切り捨てない最大合成初速（px/frame）
    HOP_GRAVITY_SCALE: 1.92,      // 基準重力（0.66）下で現行と同一のホップ軌道・天井非激突を維持する同期重力倍率
    HOP_MIN_AIR_MS: 160,          // 上昇中に誤リキャッチされないための最小滞空時間（ms）
    HOP_RECATCH_Y_MIN: 102,       // 下降中にバーへ自動再吸着するY範囲下限（予測ドット終端とのズレを抑制）
    HOP_RECATCH_Y_MAX: 138,       // 下降中にバーへ自動再吸着するY範囲上限
    HOP_MAX_AIR_MS: 2200,         // 万が一長時間空中に留まった際の安全タイムアウト（ms）
    HOP_POPUP_MAX_SCALE: 1.14,    // ホップ飛行中に手前へ飛び越える立体感の最大拡大率（+14%）
    BAR_MERGE_MAX_VALUE: 512      // 下段巨大ゼリーの吸い上げを防ぐバー上留まり合体の上限数値
};

// ==========================================
// 5. 容器（一体外枠フレーム ＆ 底面角カット）の設定
// ==========================================
export const CONTAINER = {
    FRAME_WIDTH: 8,               // 左右・底面を一周する一体グレー外枠フレーム幅（px）
    TOP_BAR_HEIGHT: 12,           // 上枠スポーナー黒ゲージ帯の高さ（px）
    CORNER_CUT_SIZE: 44           // 内壁基準の底面左右45度角カットサイズ（px）
};

// ==========================================
// 6. 上部バンパー（本家黄金比 サイド判定ボタン）の設定
// ==========================================
export const BUMPER = {
    WIDTH: 18,                    // 内壁から内側へ突出する半円ボタン厚み（px）
    HEIGHT_RATIO: 0.165,          // 画面高さに対するバンパーの高さ割合（115.5px）
    Y_RATIO: 0.30,                // 本家実測準拠の引き上げ位置（y=210、下段安全高+60px拡大）
    PUSH_THRESHOLD: 9,            // フレーム側へこの距離以上押し込まれたら赤色(ON)判定（px）
    MAX_PUSH: 15,                 // フレーム側へ押し込める最大距離（px）
    CHAMFER_RADIUS: 7,            // 上下端でゼリーが引っ掛かりにくい角丸面取り半径（px）
    GAME_OVER_HOLD_MS: 450        // 合体演出中の理不尽即死と誤爆を防ぐ左右同時押し込み確定時間（ms）
};

// ==========================================
// 7. 演出およびスコア計算用パラメータ（本家準拠 真っ白フラッシュ ＆ 連鎖の間）
// ==========================================
export const EFFECTS = {
    MERGE_EXPAND_FRAMES: 10,      // 合体時にぷるんと膨張させるフレーム数
    MERGE_EXPAND_SCALE: 1.12,     // 膨張時の最大スケール倍率
    MERGE_ANTICIPATION_MIN_MS: 80,// 合体直前の吸い付き溜め最小時間（ms）
    MERGE_ANTICIPATION_MAX_MS: 145,// 合体直前の吸い付き溜め最大時間（ms）
    MERGE_GROW_START_SCALE: 0.78, // 合体時の縮小スポーン開始倍率（重なり・絡み合い根絶）
    MERGE_GROW_DURATION_MS: 150,  // 縮小スポーンから Ease-Out-Back で定着する時間（ms）
    MERGE_GROW_OVERSHOOT: 1.08,   // 成長完了直前にわずかにボヨンと弾むオーバーシュート倍率
    MERGE_PROTECT_MIN_MS: 680,    // 合体後の真っ白フラッシュ＆連鎖保護時間下限（ms）
    MERGE_PROTECT_MAX_MS: 1200,   // 合体後の真っ白フラッシュ＆連鎖保護時間上限（ms）
    MERGE_WHITE_HOLD_RATIO: 0.30, // 保護時間のうち完全真っ白（#ffffff）を保つ前半比率（後半70%でゆっくり本色へフェード）
    MERGE_BASE_DELAY_MS: 40,      // 最小ゼリーの合体保護ディレイ基準（ms）
    MERGE_AREA_DELAY_FACTOR: 0.011, // 面積に応じて吸い付き時間を延ばす係数
    MERGE_PROTECT_AREA_FACTOR: 0.023 // 面積に応じて保護＆色戻り時間を延ばす専用係数（吸い付きのキレと分離）
};

export const SCORE = {
    COMBO_MULTIPLIER: 1.5,        // 互換維持用（本家仕様では盤面有効値総和スコアを使用）
    CHAIN_WINDOW_MS: 2100         // 連鎖合体（音程上昇演出用）の判定ウィンドウ（ms）
};

// ==========================================
// 8. UI・GRAVITY自動レイアウト環境設定
// ==========================================
export const UI = {
    SAFE_TOP_HEADER_PX: 52,       // GRAVITYアプリ内上部ネイティブボタン帯回避用ヘッダー高さ
    SAFE_TOP_HEADER_BROWSER_PX: 8,// 通常ブラウザ表示時のコンパクトな上部ヘッダー余白
    SAFE_BOTTOM_PX: 215,          // 互換維持用（v8.4 の視覚的中央配置移行により現在未使用）
    CANVAS_MARGIN_X: 6,           // 画面左右の最小余白（px）
    CANVAS_MARGIN_BOTTOM: 8,      // 画面下端の最小余白（px）
    MAX_DPR: 2,                   // Retina高精細描画の上限ピクセル比（負荷対策）
    DROP_COOLDOWN_MS: 220,        // 軽快に連続操作できる短い発射クールダウン（ms）
    GAME_OVER_DELAY_MS: 550,      // ゲームオーバー確定時の「余韻の間」（ms）
    QUEUE_SIZE: 4                 // 互換維持用
};