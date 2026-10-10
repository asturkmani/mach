import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { gateway, type LanguageModel } from "ai";

import { companyGatewayOptions } from "@/lib/ai/gateway-steps";

// A model for one company's work: an AI Gateway model that, on each call,
// adds the company's own provider keys (bring your own key) and tags the
// usage with the company. The keys are looked up when the call is made, so
// they're never part of the model itself: a durable workflow records a
// CompanyModel as just its company and model ids.

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

  private async withCompany(options: CallOptions): Promise<CallOptions> {
    const own = await companyGatewayOptions(this.organizationId);
    const given = (options.providerOptions?.gateway ?? {}) as Record<string, unknown>;
    return { ...options, providerOptions: { ...options.providerOptions, gateway: { ...own, ...given } as never } };
  }

  async doGenerate(options: CallOptions) {
    return gateway.languageModel(this.modelId).doGenerate(await this.withCompany(options));
  }

  async doStream(options: CallOptions) {
    return gateway.languageModel(this.modelId).doStream(await this.withCompany(options));
  }
}

/** The model to run for this company: a model id becomes a CompanyModel; a model object (tests) is used as it is. */
export function companyModel(organizationId: string, model: LanguageModel): LanguageModel {
  return typeof model === "string" ? new CompanyModel(organizationId, model) : model;
}
