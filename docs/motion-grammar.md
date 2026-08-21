# NOIZ LAB Motion Grammar

NOIZ LABで「なんか派手に」を再現可能な演出指示へ分解するためのモーション文法です。
[ユーザーから共有されたX投稿](https://x.com/ponzponz15/status/2089152588935803100?s=20)の語彙を出発点に、Storyboard JSONとレンダラーで扱える分類へ整理しています。

## 基本方針

絵コンテ画像は人間が構図を確認するプレビュー、高密度Storyboard JSONは時間・動き・接続を確定する正本とします。絵コンテはJSONから生成し、絵コンテへの手描き修正はJSON Patchへ変換します。

1つのカットへ無制限に効果を積まず、次の役割から必要なものを選びます。

- `primary`: カットの中心になる動き。原則1つ
- `bridge`: 前後のカットを意味的・視覚的につなぐ動き。原則1つ
- `secondary`: 主役を補助する時間差や反復。0〜1つ
- `texture`: 版ズレ、網点、紙などの表面表現。0〜2つ
- `accent`: フックやクライマックスで短時間だけ使う強調

## 語彙

### 時間とリズム

| ID | 名前 | 意味 | 主なパラメータ |
|---|---|---|---|
| `on-twos` | Animation on Twos / コマ打ち | 同じ描画を2フレーム保持し、意図的なコマ感を作る | `holdFrames`, `fps`, `phase` |
| `pose-to-pose` | Pose-to-Pose Animation / ポーズ置換 | 中間を連続補間せず、設計した主要ポーズ間をつなぐ | `poses`, `hold`, `easing` |
| `stagger` | Stagger / 時間差モーション | 同種の要素を少しずつ遅らせて動かす | `interval`, `order`, `overlap` |
| `constant-linear` | Constant Linear Motion / 規則運動 | 加減速せず一定速度で反復・移動する | `velocity`, `axis`, `loop` |
| `frame-echo` | Frame Echo / 残像・反復 | 過去フレームを時間差と減衰付きで重ねる | `copies`, `delayFrames`, `decay`, `offset` |

### 形と意味の変換

| ID | 名前 | 意味 | 主なパラメータ |
|---|---|---|---|
| `graphic-substitution` | Graphic Substitution / 図形置換 | 意味や位置を保ちながら別の図形・記号へ置き換える | `from`, `to`, `anchor`, `swapFrame` |
| `shape-morph` | Shape Morph / 形状変形 | 対応点を持つ輪郭同士を連続的に変形する | `paths`, `correspondence`, `easing` |
| `silhouette-match` | Silhouette Match / シルエット接続 | 外形の類似を使って別の被写体や場面へつなぐ | `sourceMask`, `targetMask`, `fit`, `threshold` |
| `style-transformation` | Style Transformation / スタイル変換 | 構図と主役を維持し、画材・色・質感だけを変える | `fromStyle`, `toStyle`, `preserve`, `seed` |

### 接続とマスク

| ID | 名前 | 意味 | 主なパラメータ |
|---|---|---|---|
| `track-matte` | Track Matte / マスク展開 | 文字・図形・被写体マスクを入口として次の画を見せる | `matte`, `mode`, `feather`, `invert` |
| `radial-wipe` | Radial Wipe / 放射ワイプ | 中心・角度・回転方向を持つ円形の画面転換 | `center`, `startAngle`, `direction`, `feather` |
| `match-cut` | Match Cut / 形・位置合わせ | 前後カットの形、位置、動き、意味を揃えて接続する | `matchBy`, `sourceAnchor`, `targetAnchor`, `tolerance` |

### 空間と構成

| ID | 名前 | 意味 | 主なパラメータ |
|---|---|---|---|
| `modular-grid` | Modular Grid Motion / グリッド運動 | 行列・セル・モジュールを共通規則で動かす | `rows`, `columns`, `sequence`, `gap` |
| `orthographic-pullback` | Orthographic Pull-back / 平面からの引き | 平面的な構図を保ちながら引き、周囲の世界や構造を開示する | `fromScale`, `toScale`, `revealLayers`, `parallax` |
| `controlled-chaos` | Controlled Chaos / 制御された情報過多 | グリッド、色、主役、拍のいずれかを固定しつつ情報量を増やす | `invariants`, `density`, `entropy`, `peakAt` |

### 表面と印刷表現

| ID | 名前 | 意味 | 主なパラメータ |
|---|---|---|---|
| `cmyk-misregistration` | CMYK Misregistration / 版ズレ | 色版を独立してずらし、印刷の誤差を演出する | `cyan`, `magenta`, `yellow`, `black`, `jitter` |
| `halftone` | Halftone / 網点 | 輝度や色を網点サイズ・角度へ変換する | `frequency`, `angle`, `shape`, `channels` |
| `paper-collage` | Paper Cut / Collage / 紙・コラージュ | 切り抜き境界、紙の厚み、影、質感で階層を作る | `edgeRoughness`, `paper`, `shadow`, `layers` |

## 組み合わせの文法

組み合わせは「効果の数」ではなく、各要素の役割と共通ルールで決めます。

| 目的 | 推奨構成 | 固定するもの |
|---|---|---|
| アプリ紹介 | `modular-grid` + `graphic-substitution` + `stagger` + `track-matte` | UIの整列、ブランド色、操作対象 |
| ノスタルジックな記憶 | `pose-to-pose` + `match-cut` + `on-twos` + `cmyk-misregistration` | 主役の位置、暖色、ゆっくりした拍 |
| エモい締め | `silhouette-match` + `style-transformation` + `orthographic-pullback` + `frame-echo` | シルエット、地平線、余韻 |
| 冒頭の強いフック | `controlled-chaos` + `graphic-substitution` + `frame-echo` | 主役、字幕の可読領域、ピーク時刻 |

`controlled-chaos`では、最低1つの不変条件を必須とします。例えば「中央の製品は動かさない」「4拍ごとにグリッドへ戻る」「ブランド色は3色以内」のように、視聴者が戻れる秩序を残します。

## Storyboard JSON

モーションはカット内の`motion`、接続は境界の`transitionOut`へ分けます。時間は秒と拍の両方を持ち、座標は0〜1へ正規化します。

```json
{
  "id": "shot-03",
  "time": { "start": 3.2, "duration": 1.8, "beatStart": 8, "beatLength": 4 },
  "composition": {
    "subjectBox": [0.18, 0.22, 0.68, 0.58],
    "safeArea": "tiktok-9:16",
    "vanishingPoint": [0.54, 0.38],
    "depthLayers": ["hand", "phone", "desk", "background"]
  },
  "motion": [
    {
      "technique": "pose-to-pose",
      "role": "primary",
      "targets": ["phone"],
      "params": { "poses": ["rest", "tilt", "focus"], "hold": [0.25, 0.15] }
    },
    {
      "technique": "stagger",
      "role": "secondary",
      "targets": ["ui-card-*"],
      "params": { "interval": 0.08, "order": "top-to-bottom", "overlap": 0.4 }
    },
    {
      "technique": "cmyk-misregistration",
      "role": "texture",
      "targets": ["composite"],
      "params": { "cyan": [-0.003, 0], "magenta": [0.004, 0.002], "jitter": 0.1 }
    }
  ],
  "transitionOut": {
    "technique": "match-cut",
    "duration": 0.45,
    "matchBy": ["shape", "screen-position"],
    "sourceAnchor": [0.52, 0.48],
    "targetAnchor": [0.5, 0.5],
    "curve": "ease-in-out-cubic"
  },
  "constraints": {
    "maxSimultaneousMotions": 3,
    "preserveCaptionSafeArea": true,
    "reducedMotionFallback": "crossfade"
  }
}
```

## 自動選択ルール

AIはムード名だけで技法を決めず、カットの目的を先に分類します。

1. `hook`、`explain`、`demonstrate`、`reveal`、`emotion`、`cta`のどれかを決める
2. `primary`を1つ選ぶ
3. 前後の形・位置・意味に共通点があれば`bridge`を選ぶ
4. 音と複数要素がある場合だけ`secondary`を加える
5. スタイルバイブルに沿った`texture`を加える
6. 字幕セーフエリア、点滅、同時モーション数を検証する

レンダラー未対応の技法は、Storyboard JSONへ保持したまま近い表現へフォールバックします。これにより、Web版で作ったプロジェクトを将来のDesktopレンダラーや動画生成モデルで高品質に再レンダリングできます。
