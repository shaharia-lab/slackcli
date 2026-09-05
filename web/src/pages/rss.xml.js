import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { url } from '../../site.config.mjs';

export async function GET(context) {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
  );

  return rss({
    title: 'SlackCLI - Notes from the terminal',
    description:
      'How SlackCLI works, why it is built the way it is, and what shipped in each release.',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      categories: post.data.tags,
      author: post.data.author,
      link: url(`/blog/${post.id}/`),
    })),
  });
}
