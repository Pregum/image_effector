# PIZZA会 LT（自分の仕事をソフトウェア化する）の素材

スライド本体は `public/pizza-ai-tooling-lt/` にある。ここに置いてあるのは、
スライド末尾の `assets/ending-variety.mp4` を作るために使った素材で、
ページからは参照されない。配信対象に含めないため `public/` の外に置いている。

| ディレクトリ | 中身 |
|---|---|
| `ai-frames/` | 生成した元画像（動画の各カット） |
| `processed/` | 上をNOIZ LABのプリセットで加工したもの（動画の中間生成物） |

再生成するときは次のコマンドを使う。

```sh
node scripts/noizlab-variety-video.mjs \
  public/pizza-ai-tooling-lt/assets/ending-variety.mp4 \
  docs/pizza-ai-tooling-lt/ai-frames/01-friction.jpg@FILM \
  docs/pizza-ai-tooling-lt/ai-frames/02-idea.jpg@DREAM \
  docs/pizza-ai-tooling-lt/ai-frames/03-making.jpg@NEON \
  docs/pizza-ai-tooling-lt/ai-frames/04-dawn.jpg@CINEMA \
  --transitions fade,glitch,dissolve
```
