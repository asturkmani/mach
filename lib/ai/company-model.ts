import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { gateway, type LanguageModel } from "ai";

import { companyGatewayOptions } from "@/lib/ai/gateway-steps";
import { fallbackFor, modelSettings, resolveModel } from "@/lib/ai/lineup";

// A model for one company's work: an AI Gateway model that, on each call,
// adds the company's own provider keys (bring your own key) and tags the
// usage with the company. A role ("mach1/chat", lib/ai/lineup.ts) becomes
// the company's model for it, with another provider's to fall back on, and
// each model gets its family's thinking settings unless the call set its own.
// All of it is looked up when the call is made, so none of it is part of the
// model itself: a durable workflow records a CompanyModel as just its company
// and model ids.

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
type CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0];

export class CompanyModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "gateway";
  readonly supportedUrls = {};

  constructor(
    readonly organizationId: string,
    readonly modelId: string,
  ) {}

  static [WORKFLOW_SERIALIZE](instance: CompanyModel) {
    return { organizationId: instance.organizationId, modelId: instance.modelId };
  }

  static [WORKFLOW_DESERIALIZE](data: { organizationId: string; modelId: string }) {
    return new CompanyModel(data.organizationId, data.modelId);
  }

  private async withCompany(options: CallOptions): Promise<{ model: string; options: CallOptions }> {
    const { gateway: own, lineup } = await companyGatewayOptions(this.organizationId);
    const model = resolveModel(this.modelId, lineup);
    const fallback = fallbackFor(this.modelId, lineup);
    const given = (options.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
    // The fallback's settings first, so the model's own win where they share a provider; the call's win over both.
    const settings = { ...(fallback ? modelSettings(fallback) : {}), ...modelSettings(model) };
    const providerOptions: Record<string, Record<string, unknown>> = { ...given };
    for (const [provider, values] of Object.entries(settings)) providerOptions[provider] = { ...values, ...given[provider] };
    providerOptions.gateway = { caching: "auto", ...(fallback ? { models: [fallback] } : {}), ...own, ...given.gateway };
    return { model, options: { ...options, providerOptions: providerOptions as never } };
  }

  async doGenerate(options: CallOptions) {
    const call = await this.withCompany(options);
    return gateway.languageModel(call.model).doGenerate(call.options);
  }

  async doStream(options: CallOptions) {
    const call = await this.withCompany(options);
    return gateway.languageModel(call.model).doStream(call.options);
  }
}

/** The model to run for this company: a model id becomes a CompanyModel; a model object (tests) is used as it is. */
export function companyModel(organizationId: string, model: LanguageModel): LanguageModel {
  return typeof model === "string" ? new CompanyModel(organizationId, model) : model;
}
