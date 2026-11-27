# 去AI味（ai-flavor）

治 DeepSeek 系机器人最出名的几口八股：「我记下了」「这句话我认了」「声音没抖」「总的来说」「作为AI」。

## 两道拦截

1. **before-llm-messages**：每轮把「禁写清单 + 现成说法」追加到系统提示尾部。每次随机抽样（`samplePerTag` 控制每类抽几句），所以不会固定成新的八股。
2. **after-response**：模型已经写出来的草稿里如果还蹦八股句，当场替换成语料库的说法。这一步不靠模型自觉，是硬替换。

带 `tool_calls` 的那一轮不改写（内容是过渡句，改了怕影响工具解析）。关掉 `enabled` 就完全失效。

## 语料库在哪

`corpus.js`，按「标签 → 禁句 / 可说的话」分类：

```js
{ tag: '表态承诺', banned: ['我记下了', '这句话我认了'], say: ['记着了', '这条我收下'] }
```

- 想让它多一种说法：往对应 `say` 加一条。
- 发现新八股：往 `banned` 加（**只写整句/短语，别写单字**，单字会把正常话改坏）。
- 不想改代码：插件的设置面板里有 `额外禁写句式` 和 `额外可用说法`（一行一条，格式 `标签|说法1,说法2`）。

## 和别的插件的关系

只改措辞，不碰人设、不碰记忆、不碰业务逻辑；和 memory-plus / persona-detail / chatter-guard 都不冲突。

## 排查

- 日志搜 `[ai-flavor]`：挂载、注入（`verbose` 打开才有）、改写各一行。
- 单跑改写不启机器人：

```powershell
cd <解包目录>/QQAgent-0.5/extensions/plugins/ai-flavor_1
node --input-type=module -e "import('./index.js').then(m=>{const c=m.internals.buildCorpus({});console.log(m.internals.rewriteText('我记下了，声音没抖',c.rows,c.bannedOnly))})"
```
