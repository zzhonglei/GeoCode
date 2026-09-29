import path from 'path';
import { OPENCODE_CONFIG_DIR, SKILL_SCOPE, walkSkillMdFiles, addSkillFromMdFile } from '../lib/opencode/shared.js';

// The skill directories the kernel reads, in its order: a later root wins a duplicate name.
const kernelSkillRoots = (workingDirectory) => [
  ...['skill', 'skills'].map((name) => ({ root: path.join(OPENCODE_CONFIG_DIR, name), scope: SKILL_SCOPE.USER })),
  ...(workingDirectory
    ? ['skill', 'skills'].map((name) => ({ root: path.join(workingDirectory, '.opencode', name), scope: SKILL_SCOPE.PROJECT }))
    : []),
];

export const discoverKernelSkills = (workingDirectory) => {
  const skills = new Map();
  for (const { root, scope } of kernelSkillRoots(workingDirectory)) {
    for (const skillMdPath of walkSkillMdFiles(root)) {
      addSkillFromMdFile(skills, skillMdPath, scope, 'opencode');
    }
  }
  return Array.from(skills.values());
};

export const isKernelSkillPath = (filePath, workingDirectory) => kernelSkillRoots(workingDirectory).some(({ root }) => {
  const relative = path.relative(root, path.resolve(filePath));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
});
