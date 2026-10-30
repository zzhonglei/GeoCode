// The enterprise policy with enterprise mode off: nothing pinned, nothing allowed beyond the defaults.
export const noEnterprisePolicy = () => ({
  enterpriseMode: false,
  source: null,
  organization: null,
  policyError: null,
  relayUrl: null,
  jev: null,
  allowNetworkAccess: false,
  allowedExtensions: [],
  allowLocalExtensions: false,
  // Nothing pinned, so env-runtime.js runs the bundled kernel.
  opencodeBinary: null,
  hideBuiltinSkillCatalogs: false,
});
