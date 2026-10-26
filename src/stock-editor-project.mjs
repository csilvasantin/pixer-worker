// Editor sources live outside the catalogue index: it only carries their immutable URL.
export function validateEditorProject(value) {
  if (!value || value.schema !== 'ainimation.editor.v1' || !['director','interactive'].includes(value.kind) || !value.plan || typeof value.plan !== 'object' || Array.isArray(value.plan)) throw Error('invalid-editor-project');
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > 24 * 1024 * 1024) throw Error('editor-project-too-large');
  if (/"blob:/i.test(json)) throw Error('editor-project-local-media');
  if (value.kind === 'director' && (!Array.isArray(value.plan.cast) || !Array.isArray(value.plan.stageItems))) throw Error('invalid-editor-plan');
  if (value.kind === 'interactive' && (value.plan.format !== 'ainimation-interactive' || value.plan.version !== 1 || !Array.isArray(value.plan.scenes))) throw Error('invalid-editor-plan');
  return {schema:'ainimation.editor.v1',kind:value.kind,plan:structuredClone(value.plan)};
}
