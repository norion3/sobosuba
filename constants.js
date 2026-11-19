/**
 * constants.js
 * @version v7.1 (Bar-Hop Velocity Calibration for Matter.js 0.20 _baseDelta - Phase 1)
 * @changes
 *   - Matter.js 0.20.0 の速度正規化（px/frame 単位・timeScale = 0.25）に合わせて上段ホップ定数を再正規化し、全サイズ天井非激突（上昇 47〜60px）・キレのある山なり滞空（0.55〜0.62秒）・1個飛び〜端から端までの十分な飛距離を両立（HOP_GRAVITY_SCALE: 1.35 / HOP_MIN_UP_SPEED: 5.80 / HOP_MAX_UP_SPEED: 6.55 / HOP_X_MULTIPLIER: 0.075 / HOP_MAX_SPEED: 11.5 / HOP_MIN_AIR_MS: 160）
 *   - 上記ホップ速度および非トンネリング範囲（1サブステップ最大移動 2.625〜2.75px）に合わせて、X/Y独立最大速度上限を更新（MAX_PARTICLE_VX: 10.5 / MAX_PARTICLE_VY: 11.0）
 * 
 * sobosuba風パズルの物理パラメータ、ゼリーの定義、UIセーフエリア等の定数モジュール
 * v7.x改修対象モジュールから絶対パス（/sobosuba/constants.js?v=7）でインポートして使用されます。
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

// 内幅404px（外枠8px考慮）へ最適化したサイズ成長カーブ（空間回収率約34%維持）
// 細密ビーズ数（16〜30個）により角丸多角形への液体的な追従性を高める
export const JELLY_CONFIG = {
    1:     { color: ACTIVE_THEME.colors[1],     radius: 21.5, text: ACTIVE_THEME.text, particles: 16 },
    2:     { color: ACTIVE_THEME.colors[2],     radius: 24.5, text: ACTIVE_THEME.text, particles: 16 },
    4:     { color: ACTIVE_THEME.colors[4],     radius: 28,   text: ACTIVE_THEME.text, particles: 18 },
    8:     { color: ACTIVE_THEME.colors[8],     radius: 32,   text: ACTIVE_THEME.text, particles: 18 },
    16:    { color: ACTIVE_THEME.colors[16],    radius: 36.5, text: ACTIVE_THEME.text, particles: 20 },
    32:    { color: ACTIVE_THEME.colors[32],    radius: 41.5, text: ACTIVE_THEME.text, particles: 20 },
    64:    { color: ACTIVE_THEME.colors[64],    radius: 48,   text: ACTIVE_THEME.text, particles: 22 },
    128:   { color: ACTIVE_THEME.colors[128],   radius: 55,   text: ACTIVE_THEME.text, particles: 22 },
    256:   { color: ACTIVE_THEME.colors[256],   radius: 63.5, text: ACTIVE_THEME.text, particles: 24 },
    512:   { color: ACTIVE_THEME.colors[512],   radius: 73,   text: ACTIVE_THEME.text, particles: 24 },
    1024:  { color: ACTIVE_THEME.colors[1024],  radius: 84,   text: ACTIVE_THEME.text, particles: 26 },
    2048:  { color: ACTIVE_THEME.colors[2048],  radius: 96,   text: ACTIVE_THEME.text, particles: 26 },
    4096:  { color: ACTIVE_THEME.colors[4096],  radius: 110,  text: ACTIVE_THEME.text, particles: 28 },
    8192:  { color: ACTIVE_THEME.colors[8192],  radius: 127,  text: ACTIVE_THEME.text, particles: 28 },
    16384: { color: ACTIVE_THEME.colors[16384], radius: 146,  text: ACTIVE_THEME.text, particles: 30 },
    32768: { color: ACTIVE_THEME.colors[32768], radius: 164,  text: ACTIVE_THEME.text, particles: 30 }
};

// ==========================================
// 3. 物理演算（Matter.js SUBSTEPS=4 正規化 ＋ 完全液体ソフトボディ）パラメータ
// ==========================================
export const PHYSICS = {
    GRAVITY_Y: 0.94,              // 矢印通りの弾道と自然な重みを両立する重力
    SUBSTEPS: 4,                  // 1フレームあたりの物理サブステップ分割数
    RESTITUTION: 0.16,            // 下敷き小塊の微バウンドを抑えつつ柔らかく弾む反発係数
    FRICTION: 0.015,              // 極低摩擦（狭い隙間へ液体のように滑り込む本家の手触り）
    FRICTION_STATIC: 0.015,       // 静止摩擦も極めて低く設定
    FRICTION_AIR: 0.0012,         // 極低空気抵抗（SUBSTEPS=4 での4重失速を防ぎ一直線弾道＆液体揺れを維持）

    // 隙間ゼロ高密度・細密中空ビーズリング（液体柔軟性＋質量スケーリング）
    DENSITY_PARTICLE: 0.0012,     // 基準半径（21.5px）における外周ビーズ剛体の密度
    DENSITY_SCALE_EXP: 0.65,      // 質量比を r^1.35 へ抑え下敷き圧壊を防ぐ密度スケーリング指数
    BEAD_RADIUS_RATIO: 0.18,      // 全体半径に対する細密外周ビーズ半径の基準比率
    BEAD_MIN_OVERLAP_RATIO: 1.35, // 隣接ビーズ直径 >= 1.35 * 辺長 を保証する隙間ゼロ比率
    SKIN_STIFFNESS: 0.28,         // 水風船の流動感とV字折れ・勾玉奇形防止を両立する皮の張り剛性
    BEND_STIFFNESS: 0.13,         // 液体的な密着変形とフック奇形根絶を両立する1つ飛ばし曲げ拘束
    SOFTBODY_DAMPING: 0.02,       // SUBSTEPS=4 正規化済みの低バネ減衰

    // PBD位置ワープ・真円形状保持の完全撤廃 ＋ 強化非線形バルク内圧 ＋ 体積粘性
    TARGET_AREA_RATIO: 0.98,      // シワ折れを起こさず微小な遊びを確保する目標面積比
    PBD_AREA_STIFFNESS: 0,        // 永久微振動の原因となるPBD位置ワープを完全撤廃
    PBD_MAX_CORRECTION: 0,        // PBD位置ワープ上限0（純粋な力ベース内圧へ完全移行）
    SOFTBODY_PRESSURE: 0.0024,    // 主軸となる力ベース内部圧力係数（自然な水風船の張りを確保）
    PRESSURE_NONLINEAR_GAIN: 6.5, // 極限圧迫時のみ急増する非線形バルク反発係数（13倍荷重耐性）
    PRESSURE_NONLINEAR_THRESHOLD: 0.28, // 非線形バルク反発が立ち上がる圧縮率閾値
    PRESSURE_RATIO_MAX: 3.8,      // 陽的積分安定性を守る圧力比上限クランプ
    BULK_DAMPING: 0.00055,        // 重心速度を阻害せず半径方向ビビリ振動のみ吸収する体積粘性
    SHAPE_MATCH_STIFFNESS: 0,     // 液体感を阻害する真円への記憶（Shape Matching）を完全撤廃
    INVERSION_AREA_RATIO: 0.18,   // 極限裏返り時のみ作動する穏健な自動修復閾値
    SOFTBODY_MIN_DIST_RATIO: 0.48,// 重心からの最小距離比率（ペシャンコ防止）

    // 遅延適応的圧迫ダンピング（着地直後のボヨヨン揺れ保護 ＆ 下敷き静寂化）
    SETTLE_SPEED_THRESHOLD: 0.22, // 全体静止とみなす重心速度閾値（px/frame）
    SETTLE_DELAY_MS: 350,         // 着地直後の液体ボヨヨン揺れを無傷で保護する遅延時間（ms）
    SETTLE_RAMP_MS: 550,          // 350ms→900msへ滑らかにダンピングを立ち上げるランプ時間（ms）
    SETTLE_MAX_DAMPING: 0.88,     // 完全圧迫静止時の重心相対速度減衰係数（1フレーム換算）

    // 分散非侵入排斥ソルバー（微小侵入スロップによる下敷きジッター遮断）
    ANTI_OVERLAP_STIFFNESS: 0.52, // 分散型 Point-in-Polygon 侵入ビーズ排斥強度（突起奇形防止）
    ANTI_OVERLAP_MAX_PUSH: 2.6,   // 1サブステップあたりの最大排斥距離（px）
    OVERLAP_SLOP: 0.6,            // 微小侵入（0.6px未満）を無視するデッドゾーン（px）
    MAX_PARTICLE_SPEED: 5.6,      // 互換維持用（合体衝撃波等の上限基準）
    MAX_PARTICLE_VX: 10.5,        // 落下中の横速度削れを防ぐ非トンネリング範囲内の水平最大速度（px/frame）
    MAX_PARTICLE_VY: 11.0,        // 落下中の横速度と独立して制御する垂直最大速度（px/frame）

    // 互換維持用
    DENSITY_CORE: 0.002,
    SOFTBODY_STIFFNESS: 0.04,
    SOFTBODY_PERIMETER_STIFFNESS: 0.15,

    // バンパー関連（ゼリー総質量 1.2〜11.1 に合わせた再正規化）
    BUMPER_STIFFNESS: 0.0065,     // 積み上げ圧力で自然に押し込めるバネ剛性
    BUMPER_DAMPING: 0.08,         // バンパーのバネ減衰
    BUMPER_DENSITY: 0.0035,       // バンパー質量を約6.83へ適正化しゼリーとの釣り合いを確保

    // 順方向ダイレクトエイム関連（SUBSTEPS=4 正規化済み・360度エイム解放）
    SLINGSHOT_FORCE_MULTIPLIER: 0.00015, // 互換用
    SLINGSHOT_MAX_DRAG: 150,             // 互換用
    AIM_FORCE_MULTIPLIER: 0.056,         // 端まで一直線に届く通常ショット初速係数
    AIM_MAX_DRAG: 120,                   // スマホ片手スワイプで最大威力を出しやすいドラッグ距離（px）
    AIM_CANCEL_RADIUS: 22,               // 指揺れ誤爆を防ぐキャンセル判定半径（px）

    // 合体時膨張インパルス ＆ 重心法線接近速度ベースの衝突音閾値
    MERGE_RADIAL_IMPULSE: 1.45,          // フィールド内合体時の周囲外向き速度インパルス（px/frame）
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
    Y_DAMPING: 0.88,              // 縦方向の揺れを抑えるダンピング
    SPAWN_DELAY_MS: 260,          // スポーナー供給の「ゲージの間」（ms）
    SAFETY_SPAWN_DELAY_MS: 1500,  // 両端閉塞かつバー空時のセーフティスポーン待機時間（ms）

    // 斜め下ショット時の隣カプセル角引っ掛かり防止（AABB離脱までの一時すり抜け保護）
    LAUNCH_BAR_GRACE_MAX_MS: 220, // AABB離脱待ちすり抜け保護の安全上限時間（ms）
    LAUNCH_GRACE_MIN_DY: -2,      // 浅い角度の端狙いショットでも隣カプセル失速を防ぐ下向き発動条件（px）
    LAUNCH_GRACE_MIN_SLOPE: 0.22, // 真横当てバー上合体を保護する最小下向き勾配（dy >= 0.22 * |dx|）

    // 上段「横長カプセル（ピル）形状」圧縮 ＆ 発射／着地モーフィング定数
    CHANNEL_HALF_HEIGHT: 22,      // 1(21.5px)が丸く収まり4〜64が横長に伸びるフラット帯半高
    CHANNEL_COMPRESSION_STIFFNESS: 0.16, // フラット帯上下端へ収める柔らかな圧縮フック強度
    CAPSULE_MAX_HALF_WIDTH: 110,  // 上段カプセルの最大半幅上限（px）
    MORPH_DURATION_MS: 160,       // 発射時の「変身の間」（横長カプセル→円形リング復元時間・ms）
    RECATCH_MORPH_DURATION_MS: 140, // ホップ着地時の「着席の間」（円形→横長カプセル復帰時間・ms）

    // 上段タップ選択許容範囲（画面下部の誤タップ暴発を完全防止）
    TAP_SELECT_Y_MARGIN: 75,      // バー中心から上下この距離以内（Y <= FLOAT_BAR.Y + 75）のみ選択可
    TAP_SELECT_EXTRA_RADIUS: 28,  // 各ゼリー実幅・実高に加えるタップ許容マージン（px）

    // 天井非激突 2.5D 上段飛び越えホップ ＆ セーフ・リキャッチ定数（Matter.js 0.20 px/frame 正規化済）
    HOP_TRIGGER_DY: -16,          // 横狙いショットの誤爆を防ぎつつ上向きドラッグでホップへ切替
    HOP_FORCE_MULTIPLIER: 0.026,  // 互換維持用
    HOP_MIN_UP_SPEED: 5.80,       // 天井非激突（上昇約47px）を保ち1個〜複数個を確実に飛び越える最小上向き初速（px/frame）
    HOP_MAX_UP_SPEED: 6.55,       // 天井非激突（上昇約60px）を保ち大ジャンプする最大上向き初速（px/frame）
    HOP_X_MULTIPLIER: 0.075,      // 1個飛び〜端から端まで思い通りに届く横方向初速係数
    HOP_INHERIT_VX: 0.2,          // 予測ドットとのズレを防ぐ控えめなバー横速度継承率
    HOP_MAX_SPEED: 11.5,          // 斜め強ホップの合成速度を切り捨てない最大合成初速（px/frame）
    HOP_GRAVITY_SCALE: 1.35,      // 滞空が間延びしないキレのある山なりアーチを描くホップ専用重力倍率
    HOP_MIN_AIR_MS: 160,          // 上昇中に誤リキャッチされないための最小滞空時間（ms）
    HOP_RECATCH_Y_MIN: 92,        // 下降中にバーへ自動再吸着するY範囲下限
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
    GAME_OVER_HOLD_MS: 250        // 誤爆ゼロの左右同時押し込み確定時間（ms）
};

// ==========================================
// 7. 演出およびスコア計算用パラメータ（本家準拠 真っ白フラッシュ ＆ 連鎖の間）
// ==========================================
export const EFFECTS = {
    MERGE_EXPAND_FRAMES: 10,      // 合体時にぷるんと膨張させるフレーム数
    MERGE_EXPAND_SCALE: 1.12,     // 膨張時の最大スケール倍率
    MERGE_ANTICIPATION_MIN_MS: 40,// キレのある合体前「吸い付きの間」最小時間（ms）
    MERGE_ANTICIPATION_MAX_MS: 95,// 合体前「吸い付きの間」最大時間（ms）
    MERGE_GROW_START_SCALE: 0.78, // 合体時の縮小スポーン開始倍率（重なり・絡み合い根絶）
    MERGE_GROW_DURATION_MS: 150,  // 縮小スポーンから Ease-Out-Back で定着する時間（ms）
    MERGE_GROW_OVERSHOOT: 1.08,   // 成長完了直前にわずかにボヨンと弾むオーバーシュート倍率
    MERGE_PROTECT_MIN_MS: 140,    // 合体後の真っ白フラッシュ＆連鎖保護時間下限（ms）
    MERGE_PROTECT_MAX_MS: 300,    // 合体後の真っ白フラッシュ＆連鎖保護時間上限（ms）
    MERGE_WHITE_HOLD_RATIO: 0.42, // 保護時間のうち完全真っ白（#ffffff）を保つ前半比率（後半58%で本色へフェード）
    MERGE_BASE_DELAY_MS: 40,      // 最小ゼリーの合体保護ディレイ基準（ms）
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