/** Evidence comes from the post, never from AI reason strings or the source's name. */
export function contentSignals(title: string, summary = "") {
  const clean = (value: string) => value.replace(/https?:\/\/\S+/gi, " ").slice(0, 2000);
  const t = clean(title), text = `${t} ${clean(summary)}`;
  const claim = /免费(?:领|送|获|拿|使用|开放|下载|入库)|领取|报名领|白嫖|白送|白给|白拿|薅羊毛|羊毛线报|BOGO|零元|0\s*元|限免|喜加一|赠送|激活码|兑换码|公益额度|(?:领|送)\s*\d+(?:[-~至]\d+)?\s*(?:元|话费|积分|额度|tokens?)|(?:免费|赠|送|领).{0,16}(?:额度|积分|token|credits|授权|礼包|券)|(?:free\s+(?:trial|game|software|license|credits|tier|model)|giveaway|coupon|:free\b)/i;
  const sale = /特价|特惠|促销|折扣|史低|优惠券|优惠码|黑五|black\s*friday|cyber\s*monday|%\s*off|\b(?:sale|clearance)\b|\d+(?:\.\d+)?\s*折|年付|月付|元[\/每](?:月|年)|美元[\/每](?:月|年)|\d+(?:\.\d+)?\s*元(?:起|购|到手|包邮)|(?:仅需|只要|低至|现价)\s*\d+|[$¥￥]\s*\d|(?:拼车|合租|车位|发车|明盘|出鸡|转让|出个|出售)/i;
  const incident = /停飞|停航|航班.{0,8}(?:取消|延误)|空难|坠机|遇难|伤亡|地震|战争|爆炸|罢工|旅客.{0,8}(?:遭遇|遇到)|财报|营收|净利润|股价|通胀|降息|政策|新规|召回|事故|发布会|新闻|报道|记者|宣布涨价|套餐下架|机房动态|月度汇总|活动回顾|为什么|到底|实际遇到/;
  const specificFree = (value: string) => /\bfree\s+to\s+keep\b|(?:\bis\s+free\b.{0,20}(?:Epic|Steam|GOG)|(?:游戏|软件|授权|会员|模型).{0,10}免费)|免费.{0,10}(?:游戏|软件|授权|会员|模型)/i.test(value);
  const titleClaim = claim.test(t) || specificFree(t);
  const titleSale = sale.test(t);
  const actionableSale = /特价|特惠|促销|折扣|史低|优惠券|优惠码|黑五|black\s*friday|%\s*off|抢购|低至|下单|购买|入手|到手价|拼车|合租|明盘|出鸡|出个|出售/i.test(t);
  const editorial = incident.test(t) && !titleClaim && !(titleSale && actionableSale);
  return {
    claim: titleClaim || (!editorial && (claim.test(text) || specificFree(text))),
    promotion: !editorial && (titleSale || sale.test(text)),
    editorial,
    repository: /github\.com\/[^/\s]+\/[^/\s]+|gitlab\.com\/[^/\s]+\/[^/\s]+|开源|open[\s-]*source|自托管|self-?host|源码|MIT\s*协议|Apache\s*协议/i.test(`${title} ${summary}`),
  };
}

/** Share content, not a cloud subscription or storage service. */
export function isSharedResource(title: string, summary = "", content = "", url = ""): boolean {
  const text = `${title} ${summary} ${content}`.slice(0, 12000);
  const shareLink = /(?:pan\.baidu\.com\/s\/|(?:www\.)?aliyundrive\.com\/s\/|alipan\.com\/s\/|pan\.quark\.cn\/s\/|drive\.uc\.cn\/s\/|cloud\.189\.cn\/t\/|115\.com\/s\/)/i;
  if (shareLink.test(`${url} ${text}`)) return true;
  return /网盘资源|资源合集|资源分享|提取码|转存|分享链接/.test(text) && /网盘|云盘|夸克|百度云|阿里|天翼|115|迅雷|UC网盘/i.test(text);
}

export const CLASSIFICATION_PROMPT = [
  "分类边界校验（高于来源倾向、用户偏好与示例）：",
  "kind 依据正文的主要目的，不依据网站名称。导购网站也会发新闻，新闻网站也可能发明确促销。",
  "deal 必须有可参与的购买/促销/价格/优惠券/付费套餐/交易证据。航班停飞、旅客经历、事故、财报和涨价报道不是特价好价；新闻里出现经济损失金额也不是售价。",
  "freebie 必须有明确可领取或免费使用的对象。只出现免费、限时、额度、会员这些词，不等于有福利。空泛讨论、常规新闻不得归为 freebie。",
  "opensource 必须有开源项目/源码/仓库依据；仅出现版本号不构成开源证据。",
  "网盘分享中的影视、软件、AI课程优先标 category=pan；课程内容本体可标 course，不因标题出现软件/电影/AI就改到授权、影音会员或AI额度。",
  "一般新闻与旅客经历可归 info，重要新闻归 news；keep 只控制是否值得保留，不能为保留内容强行标 deal/freebie。",
  "交易类例外：标题含「N出 / 溢价N出 / 出 / 收 / 转让 / 过户 / 出号 / 车位 / 合租 / 拼团 / 独享车」等交易意图词，且带价格或付费方式时，kind 必须是 deal，不得因为「没有促销词」判成 info。",
  "测评类例外：测评、使用记录、使用感受、选购科普、榜单推荐、横评、抄作业清单不是 freebie（没有可领取的对象），也不是 goods 优惠，应标 kind=info；只有真能领到/免费拿到的东西才是 freebie。",
  '反例：全美航班停飞4小时，普通旅客当天实际遇到了什么 → kind=info，category=world，obtain=free；不是促销。',
  '正例：航空公司限时特价机票，单程99元 → kind=deal；GitHub学生认证免费领开发者礼包 → kind=freebie。',
  '正例：50出zouter 老HK amd 9.9/月 → kind=deal，category=trade（「出」= 转让，不是资讯）；出租一个新加坡 google ultra 5x（独享车）→ kind=deal，category=carpool。',
].join("\n");
