import type { Api, Models } from "@earendil-works/pi-ai";

export type ServiceTier = "priority" | "default";

/** The APIs that know `service_tier`; another provider could reject the field. */
const TIERED: ReadonlySet<Api> = new Set<Api>(["openai-codex-responses", "openai-responses"]);

/**
 * Sends every OpenAI request on `tier`, which ChatGPT calls fast mode at `priority`. pi-durable passes
 * only curated stream options and pi-ai's simple stream drops `serviceTier`, so it goes into the
 * request body. `default` sends nothing and leaves the provider's own tier.
 */
export function withServiceTier(models: Models, tier: ServiceTier): Models {
  if (tier === "default") return models;
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    if (!TIERED.has(model.api)) return models.streamSimple(model, context, options);
    return models.streamSimple(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const tiered = { ...(payload as object), service_tier: tier };
        return (await options?.onPayload?.(tiered, payloadModel)) ?? tiered;
      },
    });
  };
  return new Proxy(models, {
    get: (target, property) => {
      if (property === "streamSimple") return streamSimple;
      const value = Reflect.get(target, property, target);
      // Bound, so methods that read private fields run on the real registry, not the proxy.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
