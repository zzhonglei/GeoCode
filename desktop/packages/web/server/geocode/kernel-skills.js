import path from 'path';
import { OPENCODE_CONFIG_DIR, SKILL_SCOPE, walkSkillMdFiles, addSkillFromMdFile, parseMdFileAsync } from '../lib/opencode/shared.js';
import { KERNEL_PROJECT_DIR } from './kernel-paths.js';

// The skill directories the kernel reads, in its order: a later root wins a duplicate name.
const kernelSkillRoots = (workingDirectory) => [
  ...['skill', 'skills'].map((name) => ({ root: path.join(OPENCODE_CONFIG_DIR, name), scope: SKILL_SCOPE.USER })),
  ...(workingDirectory
    ? ['skill', 'skills'].map((name) => ({ root: path.join(workingDirectory, KERNEL_PROJECT_DIR, name), scope: SKILL_SCOPE.PROJECT }))
    : []),
];

export const discoverKernelSkills = async (workingDirectory) => {
  const skills = new Map();
  for (const { root, scope } of kernelSkillRoots(workingDirectory)) {
    for (const skillMdPath of await walkSkillMdFiles(root)) {
      addSkillFromMdFile(skills, skillMdPath, await parseMdFileAsync(skillMdPath).catch(() => null), scope, 'opencode');
    }
  }
  return Array.from(skills.values());
};

export const isSkillFolderName = (name) => Boolean(name) && name !== '.' && name !== '..' && !/[\\/]/.test(name);

export const isKernelSkillPath = (filePath, workingDirectory) => kernelSkillRoots(workingDirectory).some(({ root }) => {
  const relative = path.relative(root, path.resolve(filePath));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
});
