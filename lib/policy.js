/**
 * Purchase guard for dsh-computer-control.
 *
 * The human chose "browse and add to cart only, never enter checkout". This
 * module enforces that as a hard, model-proof policy: every action that could
 * type, script or navigate towards a checkout/payment step is screened, and the
 * agent cannot turn the guard off from a tool call. Only the human can, by
 * editing `~/.dsh/computer-control/config.json` (`allowCheckout` /
 * `allowPayment`) or by adding entries to `extraBlockedPatterns`.
 */

/** Default deny list: checkout / ordering / payment intent, zh + en. */
export const CHECKOUT_PATTERNS = [
  '立即购买', '马上购买', '直接购买', '立刻购买', '去结算', '结算', '提交订单', '确认订单',
  '立即下单', '马上下单', '提交订单', '创建订单', '生成订单', '收银台', '确认支付', '立即支付',
  '去支付', '付款', '支付页面', '免密支付', '指纹支付', '刷脸支付', '支付密码', '开通会员并支付',
  'buy now', 'buy it now', 'place order', 'place your order', 'submit order', 'create order',
  'checkout', 'check out', 'go to checkout', 'proceed to checkout', 'proceed to payment',
  'pay now', 'make payment', 'confirm payment', 'confirm and pay', 'complete purchase',
  'purchase now', 'payment method', 'add a payment', 'credit card number', 'billing address',
];

/** Payment/checkout shapes in URLs. */
export const CHECKOUT_URL_PATTERNS = [
  /(^|[^a-z])(checkout|payment|pay|billing|purchase|order-?submit|place-?order)([^a-z]|$)/i,
  /\/cart\/checkout/i,
  /cashier|收银台/i,
];

/** Intent kinds that the guard screens. */
const TEXT_KINDS = new Set(['text', 'script', 'javascript', 'url', 'menu', 'search', 'message']);

/**
 * Throw when an action looks like it is steering towards checkout or payment.
 * @param {object} config - effective plugin config.
 * @param {object} action - `{ kind, value, what }`.
 */
export function assertAllowed(config, action) {
  const allowCheckout = config?.allowCheckout === true;
  const allowPayment = config?.allowPayment === true;
  if (allowCheckout && allowPayment) return;

  const haystack = typeof action.value === 'string' ? action.value : JSON.stringify(action.value ?? '');
  if (haystack.length === 0) return;

  const patterns = [...CHECKOUT_PATTERNS, ...(Array.isArray(config?.extraBlockedPatterns) ? config.extraBlockedPatterns : [])];
  const lowered = haystack.toLowerCase();

  for (const pattern of patterns) {
    const needle = String(pattern).toLowerCase();
    if (needle.length === 0 || !lowered.includes(needle)) continue;
    throw blocked(action, pattern, allowCheckout, allowPayment);
  }

  if (TEXT_KINDS.has(action.kind)) {
    for (const pattern of CHECKOUT_URL_PATTERNS) {
      if (pattern.test(haystack)) throw blocked(action, String(pattern), allowCheckout, allowPayment);
    }
  }
}

function blocked(action, pattern, allowCheckout, allowPayment) {
  const what = action.what ?? action.kind ?? 'action';
  return new Error(
    `blocked by the computer-control purchase guard: ${what} matches "${pattern}". ` +
    'This profile is configured for browsing and adding to cart only — checkout and payment are disabled. ' +
    `Do not try to work around it; tell the user the next step (${allowCheckout ? 'checkout' : 'checkout'}/${allowPayment ? 'payment' : 'payment'}) needs their own click. ` +
    'Only the human can lift this, by editing ~/.dsh/computer-control/config.json.',
  );
}

/** Value whose intent is impossible to misread: used by computer_policy. */
export function describePolicy(config) {
  return {
    allowCheckout: config?.allowCheckout === true,
    allowPayment: config?.allowPayment === true,
    blockedPatterns: [...CHECKOUT_PATTERNS, ...(Array.isArray(config?.extraBlockedPatterns) ? config.extraBlockedPatterns : [])],
    urlPatterns: CHECKOUT_URL_PATTERNS.map(String),
    configPath: '~/.dsh/computer-control/config.json',
  };
}

/** Screen arbitrary text without throwing; used by computer_policy action "check". */
export function screen(config, value) {
  try {
    assertAllowed(config, { kind: 'text', value, what: 'value' });
    return { allowed: true, matched: null };
  } catch (error) {
    return { allowed: false, matched: error.message };
  }
}
