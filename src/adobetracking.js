const DEFAULT_ADOBE_CONFIG = {
  enabled: false,
  consentGranted: true,
  environment: 'development',
  xdmNamespace: '_aepsupport', // Set to the namespace shown in your AEP schema, e.g. "_yourTenantId".
  decisionScope: 'bookshow-movie-offer',
  demoMode: true,
};

const AUTHORITATIVE_EVENTS = new Set([
  'booking_confirmed',
  'booking_cancelled',
  'refund_issued',
]);

const DEMO_ONLY_EVENTS = new Set([
  'login_success',
  'offer_apply_success',
  'payment_attempt',
]);

const inFlightDecisions = new Map();

function getConfig() {
  if (typeof window === 'undefined') return DEFAULT_ADOBE_CONFIG;

  return {
    ...DEFAULT_ADOBE_CONFIG,
    ...(window.BOOKSHOW_ADOBE_CONFIG || {}),
  };
}

function isReady({ allowTarget = false } = {}) {
  const config = getConfig();

  return Boolean(
    config.enabled === true &&
    config.consentGranted === true &&
    config.environment === 'development' &&
    typeof config.xdmNamespace === 'string' &&
    /^_[A-Za-z0-9]+$/.test(config.xdmNamespace) &&
    typeof window !== 'undefined' &&
    typeof window.alloy === 'function' &&
    (!allowTarget || config.decisionScope),
  );
}

function safeText(value, maxLength = 160) {
  if (value === null || value === undefined) return undefined;

  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function buildBookshowFields(eventName, context = {}) {
  const config = getConfig();

  const fields = {
    eventName,
    screen: safeText(context.screen),
    pageName: safeText(context.pageName || context.screen),
    isAuthenticated: Boolean(context.isAuthenticated),
    isDemo: Boolean(config.demoMode),
    city: safeText(context.city),
    movieId: safeText(context.movieId),
    movieTitle: safeText(context.movieTitle),
    movieGenre: safeText(context.movieGenre),
    showtime: safeText(context.showtime),
    venueId: safeText(context.venueId),
    offerId: safeText(context.offerId),
    offerCode: safeText(context.offerCode),
    offerScope: safeText(context.offerScope),
    orderId: safeText(context.orderId),
    currencyCode: safeText(context.currencyCode),
    amount: safeNumber(context.amount),
    discountAmount: safeNumber(context.discountAmount),
    outcome: safeText(context.outcome),
  };

  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

function buildXdm(eventName, context = {}) {
  const config = getConfig();
  const namespace = config.xdmNamespace;

  if (!/^_[A-Za-z0-9]+$/.test(namespace || '')) {
    throw new Error(
      'Configure xdmNamespace to match the custom namespace in the AEP schema.',
    );
  }

  const pageName = safeText(context.pageName || context.screen || 'bookshow');

  const xdm = {
    eventType: `bookshow.${eventName}`,
    web: {
      webPageDetails: {
        name: pageName,
        URL: typeof window !== 'undefined' ? window.location.href : '',
      },
    },
    [namespace]: buildBookshowFields(eventName, context),
  };

  if (typeof document !== 'undefined' && document.referrer) {
    xdm.web.webReferrer = { URL: document.referrer };
  }

  return xdm;
}

function reportFailure(action, error) {
  // Do not log identity values or full event payloads to the browser console.
  console.warn(
    `[Bookshow Adobe] ${action} failed.`,
    error?.message || error,
  );
}

export async function sendBookshowEvent(eventName, context = {}) {
  const config = getConfig();

  if (!isReady()) {
    return {
      sent: false,
      reason: 'Adobe SDK, consent, or schema namespace is not configured.',
    };
  }

  if (AUTHORITATIVE_EVENTS.has(eventName)) {
    return {
      sent: false,
      reason:
        'Booking and refund outcomes must come from the authoritative backend, not this browser app.',
    };
  }

  if (config.demoMode && DEMO_ONLY_EVENTS.has(eventName)) {
    return {
      sent: false,
      reason: 'This event is simulated by the demo app.',
    };
  }

  try {
    await window.alloy('sendEvent', {
      xdm: buildXdm(eventName, context),
    });

    return { sent: true };
  } catch (error) {
    reportFailure(`sendEvent(${eventName})`, error);

    return {
      sent: false,
      reason: 'Web SDK request failed.',
    };
  }
}

function parseOfferContent(proposition) {
  for (const item of proposition?.items || []) {
    let content = item?.data?.content ?? item?.data;

    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch {
        continue;
      }
    }

    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      continue;
    }

    const offerId = safeText(content.offerId || content.id || content.code);
    const headline = safeText(content.headline || content.title || content.name);
    const description = safeText(content.description || content.message);
    const code = safeText(content.code || content.offerCode);

    if (!offerId && !headline && !code) continue;

    return {
      offerId: offerId || 'target-offer',
      headline: headline || 'A personalized offer for your booking',
      description: description || 'Offer terms are validated at checkout.',
      code: code || '',
      label: safeText(content.label) || 'PERSONALISED FOR YOU',
      discountAmount: safeNumber(content.discountAmount),
    };
  }

  return null;
}

export async function requestMovieOffer(context = {}) {
  const config = getConfig();

  if (!isReady({ allowTarget: true })) return null;

  const dedupeKey = [
    config.decisionScope,
    context.movieId,
    context.city,
    context.isAuthenticated,
  ].join('|');

  if (inFlightDecisions.has(dedupeKey)) {
    return inFlightDecisions.get(dedupeKey);
  }

  const request = (async () => {
    try {
      const response = await window.alloy('sendEvent', {
        personalization: {
          decisionScopes: [config.decisionScope],
        },
        xdm: buildXdm('target_decision_request', context),
      });

      const proposition = (response?.propositions || []).find(
        (candidate) => candidate.scope === config.decisionScope,
      );

      const offer = parseOfferContent(proposition);

      if (!proposition || !offer) return null;

      return {
        offer,
        proposition,
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    } catch (error) {
      reportFailure('Target decision request', error);
      return null;
    } finally {
      inFlightDecisions.delete(dedupeKey);
    }
  })();

  inFlightDecisions.set(dedupeKey, request);
  return request;
}

export async function sendPropositionDisplay(proposition, context = {}) {
  if (!proposition || !isReady()) {
    return {
      sent: false,
      reason: 'Adobe SDK, consent, or schema namespace is not configured.',
    };
  }

  const propositionData = {
    id: proposition.id,
    scope: proposition.scope,
    scopeDetails: proposition.scopeDetails,
  };

  const xdm = {
    ...buildXdm('target_offer_display', context),
    eventType: 'decisioning.propositionDisplay',
    _experience: {
      decisioning: {
        propositions: [propositionData],
        propositionEventType: { display: 1 },
      },
    },
  };

  try {
    await window.alloy('sendEvent', { xdm });
    return { sent: true };
  } catch (error) {
    reportFailure('Target proposition display event', error);

    return {
      sent: false,
      reason: 'Web SDK display event failed.',
    };
  }
}