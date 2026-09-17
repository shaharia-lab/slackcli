import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),

  blog: defineCollection({
    loader: glob({ base: './src/content/blog', pattern: '**/[^_]*.md' }),
    schema: z.object({
      title: z.string(),
      // Shown under the title and used as the <meta> description and the RSS
      // summary, so it has to read as a sentence rather than a label.
      description: z.string(),
      date: z.coerce.date(),
      author: z.string().default('Shaharia Azam'),
      tags: z.array(z.string()).default([]),
      /** Pins one post to the top of the index. At most one may set it. */
      featured: z.boolean().default(false),
      draft: z.boolean().default(false),
    }),
  }),
};
