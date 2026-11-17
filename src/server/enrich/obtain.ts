import { OBTAIN_HINT, OBTAIN_LABEL, type ObtainMode } from "../../shared/taxonomy.ts";

/**
 * 获取方式：区分「点开就能白拿」和「看着像白嫖其实不完全是」。
 * 价格维度（is_free / price）回答「要不要钱」，这个维度回答「能不能确定拿到」。
 * 枚举与文案统一放在 shared/taxonomy.ts，前端直接复用同一份。
 */
export type { ObtainMode };
export { OBTAIN_HINT, OBTAIN_LABEL };

/** 只有这两种算真正的「完全白嫖」。 */
export const CLEAN_OBTAIN: ObtainMode[] = ["free"];

/**
 * 规则兜底：AI 没结论时用关键词粗分。
 * 顺序有意为之 —— 抽奖优先于条件，推广优先于免费（「免费体验我们的服务」是广告）。
 */
export function guessObtain(title: string, summary = ""): ObtainMode {
  const t = title + " " + summary;

  // 抽奖 / 名额：能不能拿到不由你决定
  if (/抽奖|抽\s*\d+\s*(份|个|名|位)|抽取|随机送|开奖|中奖|摇号|锦鲤|抽\s*\d+|名额有限.*抽|抽名额/.test(t)) {
    return "lottery";
  }
  // 推广 / 广告：福利只是钩子
  if (/招募|代理|加盟|官方旗舰|我们的服务|自营|软广|推广位|商务合作|招商|诚招|带货|优惠码.*分成/.test(t)) {
    return "promo";
  }
  // 试用：到期收费
  if (/试用|免费体验\s*\d+\s*天|首月免费|首月\s*\d|体验期|试用期|免费体验卡|7\s*天免费|30\s*天免费|\b(?:free\s+trial|demo\s+(?:is\s+)?(?:now\s+)?available)\b|(?:\bfree\b.*\bdemo\b|\bdemo\b.*\bfree\b)/i.test(t)) {
    return "trial";
  }
  // 有条件：要付出行动才能拿
  if (/回帖|盖楼|转发|关注.*领取|邀请|拉新|实名|绑卡|下单|首单|充值|发帖|评论.*领取|签到.*领|分享.*得/.test(t)) {
    return "conditional";
  }
  return "free";
}
