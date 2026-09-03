/**
 * Builds the (person x garment) job matrix from the input folder layout:
 *
 *   input/
 *     people/<gender>/*.jpg
 *     garments/<gender>/<category-slug>/*.jpg
 *
 * <gender> is just a folder name chosen by whoever fills the input directory —
 * it is never sent to the API. It only decides which people get matched
 * against which garments/ subtree, since garment categories in this system
 * are not gender-scoped (dev_tryon_categories has no gender column — see
 * packages/db/src/schema/dev-api.ts). <category-slug> must match an active
 * slug from GET /v1/dev/categories; run.mts filters against that list.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface TryonJobSpec {
  gender: string;
  personFile: string;
  personName: string;
  categorySlug: string;
  garmentFile: string;
  garmentName: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listImages(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(dir, f))
    .sort();
}

function listSubdirs(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function scanInput(inputDir: string): { jobs: TryonJobSpec[]; warnings: string[] } {
  const warnings: string[] = [];
  const jobs: TryonJobSpec[] = [];

  const peopleRoot = path.join(inputDir, 'people');
  const garmentsRoot = path.join(inputDir, 'garments');
  const genders = [...new Set([...listSubdirs(peopleRoot), ...listSubdirs(garmentsRoot)])].sort();

  if (genders.length === 0) {
    warnings.push(`No folders found under ${peopleRoot} or ${garmentsRoot} — see README.md`);
    return { jobs, warnings };
  }

  for (const gender of genders) {
    const people = listImages(path.join(peopleRoot, gender));
    const categories = listSubdirs(path.join(garmentsRoot, gender));

    if (people.length === 0) {
      warnings.push(`people/${gender}/ has no images — skipping this gender`);
      continue;
    }
    if (categories.length === 0) {
      warnings.push(`garments/${gender}/ has no category folders — skipping this gender`);
      continue;
    }

    for (const categorySlug of categories) {
      const garmentImages = listImages(path.join(garmentsRoot, gender, categorySlug));
      if (garmentImages.length === 0) {
        warnings.push(`garments/${gender}/${categorySlug}/ has no images — skipping`);
        continue;
      }
      for (const personFile of people) {
        for (const garmentFile of garmentImages) {
          jobs.push({
            gender,
            personFile,
            personName: path.basename(personFile, path.extname(personFile)),
            categorySlug,
            garmentFile,
            garmentName: path.basename(garmentFile, path.extname(garmentFile)),
          });
        }
      }
    }
  }

  return { jobs, warnings };
}
