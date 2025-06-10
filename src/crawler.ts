// src/crawler.ts

// --- IMPORTANT: These two Interfaces are crucial for type compatibility ---
// They manually define the core methods/properties of Puppeteer's Request and HTTPResponse
// This bypasses potential versioning issues with @types/puppeteer where these
// types might not be directly exported or behave differently.
interface CustomRequest {
  url(): string;
  resourceType(): string;
  abort(): void;
  continue(options?: { url?: string; method?: string; postData?: string; headers?: Record<string, string>; }): void;
  // Add other Request methods/properties if your code needs them, e.g., method(), headers() etc.
}

interface CustomHTTPResponse {
  url(): string;
  status(): number;
  ok(): boolean;
  headers(): Record<string, string>;
  text(): Promise<string>;
  // Add other HTTPResponse methods/properties if your code needs them, e.g., json(), buffer() etc.
}
// --- END Custom Interface Definitions ---

import puppeteer, { Browser, Page } from 'puppeteer'; // Only Browser and Page are directly imported
import { program } from 'commander';
import { promises as fs } from 'fs';
import { URL } from 'url';
import path from 'path';
import robotsParser from 'robots-txt-parser'; // <-- این خط را تغییر دهیدimport * as xml2js from 'xml2js';
import * as xml2js from 'xml2js'; 

import { performance } from 'perf_hooks';

// --- Interfaces for type safety and structured data ---
interface CrawlConfig {
  startUrl: string;
  maxDepth: number;
  concurrency: number; // Max concurrent pages/tabs
  politenessDelay: number; // Delay between initiating new page crawls (ms)
  safeClick: boolean; // Simulate clicks on "load more" type buttons
  scrollMode: boolean; // Handle infinite scroll
  respectSitemap: boolean; // Parse and prioritize sitemap/robots.txt
  outputDir: string; // Directory for crawl results
  extractJsLinks: boolean; // Flag to extract all JS links (static & dynamic)
}

interface CrawlNode {
  url: string;
  normalizedUrl: string; // Stored for easier graph lookup
  title: string | null;
  statusCode: number | null;
  loadTime: number; // Page load time in ms
  errors: string[]; // JS errors, HTTP errors
  headers: Record<string, string>; // Response headers for the main document
  csp: string | null; // Content-Security-Policy header
  forms: string[]; // Detected form actions/IDs
  consoleLogs?: string[]; // Console output (if safeClick enabled)
  cookies?: string[]; // Cookie names (if safeClick enabled)
  localStorage?: Record<string, string>; // localStorage keys/values (if safeClick enabled)
  sessionStorage?: Record<string, string>; // sessionStorage keys/values (if safeClick enabled)
  jsLinks?: string[]; // Discovered JavaScript links (if extractJsLinks enabled)
}

interface CrawlEdge {
  source: string; // Normalized URL of the source node
  target: string; // Normalized URL of the target node
  type: 'link' | 'navigation'; // Type of transition
}

interface CrawlGraph {
  nodes: CrawlNode[];
  edges: CrawlEdge[];
}

// --- Utility Functions ---

/**
 * Custom delay function to pause execution.
 * @param ms - Milliseconds to delay.
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Normalizes a URL to ensure consistency for visited checks.
 * Removes hash, query parameters, and ensures consistent trailing slash (unless it's the root).
 * @param url - The URL string to normalize.
 * @returns Normalized URL string.
 */
const normalizeUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.hash = ''; // Remove URL hash
    parsed.search = ''; // Remove query parameters
    let normalized = parsed.toString();
    // Remove trailing slash unless it's the root path '/'
    if (normalized.endsWith('/') && parsed.pathname.length > 1) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch (e) {
    console.warn(`[WARN] Failed to normalize URL "${url}": ${(e as Error).message}`);
    return url; // Return original if normalization fails
  }
};

// --- Main Crawler Class ---
class WebsiteCrawler {
  private config: CrawlConfig;
  private browser: Browser | null = null;
  // Using Set for efficient O(1) lookup of visited URLs
  private visitedUrls: Set<string> = new Set();
  private graph: CrawlGraph = { nodes: [], edges: [] };
  // Store the parsed robots.txt object (can be 'any' as its type definitions are sometimes tricky)
  private robots: any = null;
  private sitemapUrls: Set<string> = new Set(); // Use Set to avoid duplicate sitemap URLs
  private activePages = 0; // Counter for currently active browser pages

  /**
   * Initializes the crawler with the given configuration.
   * @param config - The crawl configuration.
   */
  constructor(config: CrawlConfig) {
    this.config = config;
    // Pre-normalize and add start URL to visited to prevent immediate re-crawling
    this.visitedUrls.add(normalizeUrl(this.config.startUrl));
  }

  /**
   * Initializes the browser and potentially parses robots.txt/sitemap.
   */
  async initialize(): Promise<void> {
    console.log('[INFO] Initializing browser...');
    this.browser = await puppeteer.launch({
      headless: true, // Run in headless mode for performance
      args: [
        '--no-sandbox', // Recommended for Docker/CI environments
        '--disable-setuid-sandbox', // Disable sandbox for Puppeteer
        '--disable-dev-shm-usage', // Recommended for Docker environments to prevent OOM
        '--disable-gpu', // Disable GPU hardware acceleration
        '--disable-web-security', // Might be useful for specific recon tasks, but generally not recommended for general use
        '--disable-features=IsolateOrigins,site-per-process', // Helps with cross-origin navigation
        '--incognito', // Use incognito mode for clean sessions
      ],
      timeout: 60000, // Global browser launch timeout
    });
    console.log('[INFO] Browser launched.');

    if (this.config.respectSitemap) {
      console.log('[INFO] Attempting to parse robots.txt and sitemaps...');
      await this.parseRobotsTxt();
      if (this.sitemapUrls.size > 0) {
        console.log(`[INFO] Found ${this.sitemapUrls.size} unique URLs from sitemap(s).`);
      } else {
        console.log('[INFO] No sitemaps found or parsed from robots.txt.');
      }
    }
  }

  /**
   * Parses robots.txt and extracts sitemap URLs.
   */
  private async parseRobotsTxt(): Promise<void> {
    const robotsUrl = new URL('/robots.txt', this.config.startUrl).toString();
    let page: Page | null = null;
    try {
      page = await this.browser!.newPage();
      console.log(`[INFO] Fetching robots.txt from: ${robotsUrl}`);
      // Short timeout for robots.txt as it should be fast
      const response = await page.goto(robotsUrl, { waitUntil: 'networkidle2', timeout: 10000 });

      if (response && response.status() === 200) {
        const text = await response.text();
        // Correct usage for 'robots-txt-parser' with direct named import 'parseRobots'
        this.robots = robotsParser(robotsUrl, text); // <-- CHANGE THIS LINE

      if (this.robots && typeof this.robots.getSitemaps === 'function') {
        let sitemapsFromRobots = this.robots.getSitemaps();

        // Ensure sitemapsFromRobots is an array, even if it's a single string or null/undefined
        if (sitemapsFromRobots === null || sitemapsFromRobots === undefined) {
            sitemapsFromRobots = []; // Treat as empty array if nothing found
        } else if (!Array.isArray(sitemapsFromRobots)) {
            sitemapsFromRobots = [sitemapsFromRobots]; // Convert single item to an array
        }

        // --- NEW LOGIC TO ENSURE URL IS A STRING ---
        const validSitemapUrls: string[] = [];
        for (const item of sitemapsFromRobots) {
            if (typeof item === 'string') {
                validSitemapUrls.push(item);
            } else if (item && typeof (item as Promise<string>).then === 'function') {
                // If it's a Promise, await its resolution
                try {
                    const resolvedUrl = await (item as Promise<string>);
                    if (typeof resolvedUrl === 'string') {
                        validSitemapUrls.push(resolvedUrl);
                    } else {
                        console.warn(`[WARN] Resolved sitemap item was not a string: ${resolvedUrl}`);
                    }
                } catch (e) {
                    console.error(`[ERROR] Failed to resolve sitemap URL promise: ${e}`);
                }
            } else {
                console.warn(`[WARN] Unexpected type for sitemap item found in robots.txt: ${typeof item}, value: ${item}`);
            }
        }

        for (const sitemapUrl of validSitemapUrls) { // Now iterate over confirmed strings
          console.log(`[INFO] Found sitemap URL in robots.txt: ${sitemapUrl}`);
          const urlsFromSitemap = await this.fetchSitemap(sitemapUrl);
          urlsFromSitemap.forEach(url => this.sitemapUrls.add(url));
        }
      }else {
            console.warn("[WARN] Robots.txt parser instance does not expose 'getSitemaps' method or was not initialized correctly.");
        }
      } else {
        console.warn(`[WARN] Failed to fetch robots.txt (Status: ${response?.status() || 'N/A'}) from ${robotsUrl}`);
      }
    } catch (error) {
      console.warn(`[ERROR] Error parsing robots.txt from ${robotsUrl}: ${(error as Error).message}`);
    } finally {
        if (page) {
            await page.close();
        }
    }
  }

  /**
   * Fetches and parses a sitemap (or sitemap index) XML file.
   * Handles recursive fetching for sitemap index files.
   * @param url - The URL of the sitemap XML file.
   * @returns A promise that resolves to an array of URLs found in the sitemap.
   */
  private async fetchSitemap(url: string): Promise<string[]> {
    let page: Page | null = null;
    try {
      page = await this.browser!.newPage();
      console.log(`[INFO] Fetching sitemap from: ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }); // Longer timeout for sitemaps

      if (!response || response.status() !== 200) {
        console.warn(`[WARN] Failed to fetch sitemap from ${url} (Status: ${response?.status() || 'N/A'})`);
        return [];
      }
      const text = await response.text();
      // Parse XML with options for explicitArray: false to simplify structure
      const parsed = await xml2js.parseStringPromise(text, { explicitArray: false, mergeAttrs: true });

      let urls: string[] = [];
      if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
        // This is a sitemap index, recursively fetch child sitemaps
        const sitemapsInIndex = Array.isArray(parsed.sitemapindex.sitemap)
          ? parsed.sitemapindex.sitemap
          : [parsed.sitemapindex.sitemap]; // Ensure it's an array for iteration

        for (const sitemapEntry of sitemapsInIndex) {
          if (sitemapEntry.loc) {
            console.log(`[INFO] Found nested sitemap in index: ${sitemapEntry.loc}`);
            const nestedUrls = await this.fetchSitemap(sitemapEntry.loc);
            urls.push(...nestedUrls);
          }
        }
      } else if (parsed.urlset && parsed.urlset.url) {
        // This is a regular sitemap
        const urlsInSet = Array.isArray(parsed.urlset.url)
          ? parsed.urlset.url
          : [parsed.urlset.url]; // Ensure it's an array

        urls = urlsInSet
          .map((entry: any) => entry.loc)
          .filter((loc: string | undefined): loc is string => typeof loc === 'string'); // Filter out invalid URLs
      }

      console.log(`[INFO] Extracted ${urls.length} URLs from sitemap: ${url}`);
      return urls;
    } catch (error) {
      console.warn(`[ERROR] Error fetching or parsing sitemap from ${url}: ${(error as Error).message}`);
      return [];
    } finally {
        if (page) {
            await page.close();
        }
    }
  }

  /**
   * Main crawling loop. Manages the queue and concurrency.
   */
  async crawl(): Promise<void> {
    const startTime = performance.now();
    const queue: { url: string; depth: number }[] = [];
    const pendingPromises: Promise<void>[] = [];

    // Initialize queue with start URL
    queue.push({ url: this.config.startUrl, depth: 0 });

    // Add sitemap URLs to the queue if respecting sitemap and within maxDepth
    if (this.config.respectSitemap) {
      for (const sitemapUrl of this.sitemapUrls) {
        const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
        // Only add if not already visited (e.g., if it was the start URL)
        if (!this.visitedUrls.has(normalizedSitemapUrl)) {
          // Treat sitemap URLs as depth 0 for initial queueing
          queue.push({ url: sitemapUrl, depth: 0 });
        }
      }
    }

    // Main crawling loop: continues as long as there are URLs in queue or pending pages
    while (queue.length > 0 || pendingPromises.length > 0) {
      // Dispatch new pages if queue has items and concurrency limit is not met
      while (queue.length > 0 && this.activePages < this.config.concurrency) {
        const { url, depth } = queue.shift()!; // Get next URL from queue
        const normalizedUrl = normalizeUrl(url);

        // Skip conditions: max depth, already visited, robots.txt disallow
        if (depth > this.config.maxDepth) {
          // console.log(`[INFO] Skipping ${url}: Max depth reached.`);
          continue;
        }
        if (this.visitedUrls.has(normalizedUrl)) {
          // console.log(`[INFO] Skipping ${url}: Already visited.`);
          continue;
        }

        // Check robots.txt rules if enabled
        if (this.config.respectSitemap && this.robots) {
          if (typeof this.robots.canCrawl === 'function' && !this.robots.canCrawl(normalizedUrl, 'MyCrawler')) {
            console.log(`[INFO] Skipping ${url}: Disallowed by robots.txt.`);
            this.visitedUrls.add(normalizedUrl); // Mark as visited to avoid re-queuing
            continue;
          }
        }

        console.log(`[CRAWL] Starting: ${url} (Depth: ${depth}, Active: ${this.activePages}/${this.config.concurrency})`);
        // Mark as visited immediately to prevent race conditions in adding to queue
        this.visitedUrls.add(normalizedUrl);

        // Launch crawlPage as a promise and add to pending list
        const crawlPromise = this.crawlPage(url, depth, queue).finally(() => {
            this.activePages--; // Decrement active pages when a page crawl completes
            // Remove the resolved/rejected promise from the pending list
            const index = pendingPromises.indexOf(crawlPromise);
            if (index > -1) {
                pendingPromises.splice(index, 1);
            }
        });
        pendingPromises.push(crawlPromise);
        this.activePages++;

        // Apply politeness delay after launching a new page
        await delay(this.config.politenessDelay);
      }

      // If no more items in queue but still pending pages, wait for at least one to complete
      if (queue.length === 0 && pendingPromises.length > 0) {
        console.log(`[INFO] Queue empty, waiting for ${pendingPromises.length} pages to finish...`);
        await Promise.race(pendingPromises); // Wait for the fastest-finishing page
      }
    }

    await this.browser!.close();

    const endTime = performance.now();
    await this.saveResults();
    console.log(`\n[COMPLETE] Crawl finished in ${(endTime - startTime) / 1000} seconds.`);
    console.log(`[COMPLETE] Visited ${this.graph.nodes.length} unique URLs.`);
  }

  /**
   * Handles the crawling of a single page, extracts data, and queues new links.
   * @param url - The URL to crawl.
   * @param depth - Current crawl depth.
   * @param queue - The main crawling queue to add new links to.
   */
  private async crawlPage(url: string, depth: number, queue: { url: string; depth: number }[]): Promise<void> {
    let page: Page | null = null;
    const normalizedUrl = normalizeUrl(url);
    const node: CrawlNode = {
      url,
      normalizedUrl,
      title: null,
      statusCode: null,
      loadTime: 0,
      errors: [],
      headers: {},
      csp: null,
      forms: [],
      consoleLogs: this.config.safeClick ? [] : undefined, // Only collect if safeClick is on
      cookies: this.config.safeClick ? [] : undefined,
      localStorage: this.config.safeClick ? {} : undefined,
      sessionStorage: this.config.safeClick ? {} : undefined,
      jsLinks: this.config.extractJsLinks ? [] : undefined, // Only collect if extractJsLinks is on
    };

    const discoveredJsUrlsForThisPage: Set<string> = new Set(); // Use Set for unique JS links per page

    try {
      const startTime = performance.now();
      page = await this.browser!.newPage();

      // Configure request interception to block unnecessary resources and capture JS links
      await page.setRequestInterception(true);
      // Use CustomRequest for typing
      page.on('request', (request: CustomRequest) => {
        // Block non-essential resources to improve load time and reduce bandwidth
        // Important: Do not block JS files if you need them to run the page or extract dynamically loaded ones.
        if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
          request.abort();
        } else {
          // Capture all JS links (both static and dynamic requests)
          const requestUrl = request.url();
          if (this.config.extractJsLinks && (requestUrl.endsWith('.js') || requestUrl.includes('.js?'))) {
              discoveredJsUrlsForThisPage.add(normalizeUrl(requestUrl));
          }
          request.continue();
        }
      });

      // Capture console logs and page errors for security analysis
      if (this.config.safeClick) { // Reusing safeClick flag for general logging
        page.on('console', (msg) => node.consoleLogs?.push(`[CONSOLE] ${msg.type().toUpperCase()}: ${msg.text()}`));
        page.on('pageerror', (error) => node.errors.push(`[PAGE_ERROR] ${error.message}`));
      }

      // Capture response status and headers for the main document
      // Use CustomHTTPResponse for typing
      page.on('response', (response: CustomHTTPResponse) => {
        if (response.url() === url) { // Only for the main document's response
          node.statusCode = response.status();
          node.headers = response.headers();
          node.csp = response.headers()['content-security-policy'] || null;
          if (!response.ok()) { // Log non-2xx status codes as errors
            node.errors.push(`[HTTP_ERROR] Status ${response.status()} for ${response.url()}`);
          }
        }
      });

      // Navigate to the page
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); // Longer timeout for page loads
      node.loadTime = performance.now() - startTime;
      node.title = await page.title();

      // Collect Security/Reconnaissance data if safeClick is enabled
      if (this.config.safeClick) {
        // Detect forms
        node.forms = await page.$$eval('form', (forms) =>
          forms.map((form) => form.action || form.id || 'unnamed_form_[' + Math.random().toString(36).substring(7) + ']')
        );

        // Capture cookies
        node.cookies = (await page.cookies()).map((c) => c.name);

        // Capture localStorage and sessionStorage
        node.localStorage = await page.evaluate(() => {
            const data: Record<string, string> = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key) data[key] = localStorage.getItem(key) || '';
            }
            return data;
        });
        node.sessionStorage = await page.evaluate(() => {
            const data: Record<string, string> = {};
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key) data[key] = sessionStorage.getItem(key) || '';
            }
            return data;
        });
      }

      // Handle infinite scroll (scrolls down a few times)
      if (this.config.scrollMode) {
        await this.handleInfiniteScroll(page);
      }

      // Extract all links (a[href], link[rel=alternate], etc.)
      const extractedLinks = await this.extractLinks(page);
      
      // Store collected JS links in the node
      if (this.config.extractJsLinks) {
          node.jsLinks = Array.from(discoveredJsUrlsForThisPage);
      }

      // Add node to graph
      this.graph.nodes.push(node);

      // Add new URLs to queue and edges to graph
      for (const link of extractedLinks) {
        const normalizedLink = normalizeUrl(link);
        const baseUrl = new URL(this.config.startUrl); // Reference domain for internal links
        const linkUrl = new URL(link);

        // Only queue internal links within the same hostname and not yet visited
        if (linkUrl.hostname === baseUrl.hostname && !this.visitedUrls.has(normalizedLink)) {
          this.graph.edges.push({ source: normalizedUrl, target: normalizedLink, type: 'link' });
          queue.push({ url: link, depth: depth + 1 });
          this.visitedUrls.add(normalizedLink); // Mark as visited early to prevent duplicates
        }
      }

      // Simulate safe clicks on "load more" buttons and similar
      if (this.config.safeClick) {
        await this.simulateSafeClicks(page, normalizedUrl, queue, depth);
      }

    } catch (error) {
      node.errors.push(`[CRAWL_ERROR] ${(error as Error).message}`);
      // If the node hasn't been added yet (e.g., if page.goto failed early), add it
      if (!this.graph.nodes.some(n => n.normalizedUrl === normalizedUrl)) {
          this.graph.nodes.push(node);
      }
      console.warn(`[WARN] Failed to crawl ${url}: ${(error as Error).message}`);
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  /**
   * Extracts all relevant links from the rendered DOM.
   * @param page - The Puppeteer page object.
   * @returns A promise that resolves to an array of absolute URLs.
   */
  private async extractLinks(page: Page): Promise<string[]> {
    try {
      const links = await page.$$eval('a[href], link[rel="alternate"][href], area[href]', (elements, pageUrl) =>
        Array.from(elements)
          .map((el) => el.getAttribute('href'))
          .filter((href): href is string => !!href && href.trim() !== '') // Filter out empty/null hrefs
          .map((href) => {
            try {
              // Construct absolute URL from href, relative to pageUrl
              return new URL(href, pageUrl as string).toString();
            } catch {
              return ''; // Return empty string for invalid URLs
            }
          })
          .filter((href) => href.startsWith('http')) // Only consider http(s) links
      , page.url());
      return links;
    } catch (error) {
      console.warn(`[WARN] Failed to extract links from ${page.url()}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Handles infinite scroll on pages by scrolling down multiple times.
   * @param page - The Puppeteer page object.
   */
  private async handleInfiniteScroll(page: Page): Promise<void> {
    try {
      let previousHeight = await page.evaluate('document.body.scrollHeight');
      for (let i = 0; i < 5; i++) { // Max 5 scrolls to reveal content
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await delay(2000); // Wait for content to load after scroll
        const currentHeight = await page.evaluate('document.body.scrollHeight');
        if (currentHeight === previousHeight) {
            console.log(`[INFO] Infinite scroll: No new content loaded after ${i + 1} scrolls.`);
            break; // Stop if no new content loads
        }
        previousHeight = currentHeight;
      }
    } catch (error) {
      console.warn(`[WARN] Infinite scroll failed on ${page.url()}: ${(error as Error).message}`);
    }
  }

  /**
   * Simulates safe clicks on "load more" style buttons to uncover more content/links.
   * This is a robust implementation attempting to re-query elements to handle DOM changes.
   * @param page - The Puppeteer page object.
   * @param sourceUrl - The normalized URL of the current page (for graph edge).
   * @param queue - The main crawling queue.
   * @param depth - Current crawl depth.
   */
  private async simulateSafeClicks(page: Page, sourceUrl: string, queue: { url: string; depth: number }[], depth: number): Promise<void> {
    const buttonSelectors = 'button, [role="button"], a[href="#"], input[type="submit"]';
    // Keywords for "load more", "show more", "next", pagination etc. (English and Persian)
    const keywords = ['load more', 'show more', 'next', 'view all', 'read more', 'more results', 'ادامه', 'بیشتر', 'بعدی'];

    // Loop a few times to account for multiple "load more" clicks revealing content
    for (let i = 0; i < 3; i++) {
      // Find all relevant clickable elements in the current DOM state
      const clickableElementsInfo = await page.evaluate((selector, kws) => {
        const uniqueElements: { text: string; outerHtmlPartial: string }[] = []; // Moved initialization here
        
        (Array.from(document.querySelectorAll(selector)) as HTMLElement[]).forEach((el) => {
            const textContent = el.textContent?.toLowerCase();
            const id = el.id?.toLowerCase();
            const className = el.className?.toLowerCase();

            const isRelevant = (textContent && kws.some(keyword => textContent.includes(keyword))) ||
                               (id && kws.some(keyword => id.includes(keyword))) ||
                               (className && kws.some(keyword => className.includes(keyword)));
            
            // Check for visibility (basic check)
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden' && window.getComputedStyle(el).display !== 'none';

            if (isRelevant && isVisible) {
                const info = {
                    text: el.textContent?.trim() || el.outerHTML.substring(0, 50),
                    // Use a short snippet of outerHTML to re-identify (might be brittle but better than nothing)
                    outerHtmlPartial: el.outerHTML.substring(0, Math.min(el.outerHTML.length, 100))
                };
                // Add if not already added to avoid redundant clicks on same identified element
                if (!uniqueElements.some(u => u.outerHtmlPartial === info.outerHtmlPartial)) {
                    uniqueElements.push(info);
                }
            }
        });
        return uniqueElements;
      }, buttonSelectors, keywords);


      if (clickableElementsInfo.length === 0) {
        // console.log(`[INFO] No relevant clickable elements found after ${i} attempts.`);
        break; // No more relevant elements to click
      }

      let clickedSomethingInThisIteration = false;
      for (const elementInfo of clickableElementsInfo) {
        try {
          const currentUrl = page.url();
          // Attempt to re-find the element in the current DOM state
          // Explicitly type the return value of the callback
          const targetElementHandle = await page.evaluateHandle((info, selector): HTMLElement | null => {
            const elements = document.querySelectorAll(selector);
            for (const el of Array.from(elements) as HTMLElement[]) { // Cast Array.from result to HTMLElement[]
                const htmlEl = el; // el is already HTMLElement due to prior cast

                // Check if it's the specific element we want to click by text or partial HTML
                // Ensure it's an actual element, not just a node, and is visible
                if (htmlEl && typeof htmlEl.click === 'function' && 
                    (htmlEl.textContent?.trim() === info.text || htmlEl.outerHTML.includes(info.outerHtmlPartial))) {
                    // Basic visibility check
                    const rect = htmlEl.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(htmlEl).visibility !== 'hidden' && window.getComputedStyle(htmlEl).display !== 'none') {
                        return htmlEl; // Return as HTMLElement
                    }
                }
            }
            return null;
          }, elementInfo, buttonSelectors);

          // Get the ElementHandle and check if it's a clickable HTMLElement
          const clickableElement = targetElementHandle.asElement();
          if (!clickableElement || !(clickableElement instanceof HTMLElement)) {
              // Element not found, or not a clickable HTMLElement (e.g., TextNode, SVGElement)
              console.warn(`[WARN] Skipping non-clickable element for "${elementInfo.text.substring(0, 30)}...": Not found or not an HTMLElement.`);
              continue;
          }

          console.log(`[INFO] Clicking potential "load more" element: "${elementInfo.text.substring(0, 30)}..." on ${currentUrl}`);
          await clickableElement.click(); // Now TypeScript knows it's an HTMLElement, which has click()
          clickedSomethingInThisIteration = true;

          // Wait for content to load or navigation to occur. Use Promise.race to handle both.
          await Promise.race([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 7000 }), // Wait for navigation
            delay(3000) // Or wait for AJAX content to load without navigation
          ]).catch(() => { /* Ignore timeouts if no navigation occurred, assume AJAX */ });

          const newUrl = page.url();
          // If a navigation occurred, add it to the queue/graph
          if (newUrl !== currentUrl) {
            const normalizedNewUrl = normalizeUrl(newUrl);
            console.log(`[INFO] Navigation after click: ${currentUrl} -> ${newUrl}`);
            this.graph.edges.push({ source: sourceUrl, target: normalizedNewUrl, type: 'navigation' });
            if (!this.visitedUrls.has(normalizedNewUrl)) {
               queue.push({ url: newUrl, depth: depth + 1 });
               this.visitedUrls.add(normalizedNewUrl);
            }
          }
          // After a click, break the inner loop and re-evaluate the page for new clickable elements
          // This prevents trying to click stale elements if the DOM significantly changed.
          break;

        } catch (error) {
          console.warn(`[WARN] Safe click attempt failed on "${elementInfo.text.substring(0, 30)}..." on ${page.url()}: ${(error as Error).message}`);
        }
      }
      
      if (!clickedSomethingInThisIteration) {
          // If no element was successfully clicked in this iteration, stop trying
          break;
      }
      await delay(1000); // Small delay between click attempts to allow DOM to settle
    }
  }

  /**
   * Saves the collected crawl results to JSON, CSV, and Graphviz DOT formats.
   */
  private async saveResults(): Promise<void> {
    const outputDir = this.config.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    console.log(`[INFO] Saving crawl results to: ${outputDir}`);

    // JSON output (raw graph data)
    await fs.writeFile(
      path.join(outputDir, 'crawl_graph.json'),
      JSON.stringify(this.graph, null, 2)
    );
    console.log('[INFO] crawl_graph.json saved.');

    // CSV output (flat list of nodes with their details)
    const csvHeader = [
      'URL', 'Normalized URL', 'Title', 'Status Code', 'Load Time (ms)', 'Errors',
      'CSP', 'Forms', 'Console Logs', 'Cookies', 'Local Storage Keys',
      'Session Storage Keys', 'JS Links'
    ].join(',');

    const csvRows = this.graph.nodes.map((node) => {
      // Helper to safely format string for CSV (handle commas and quotes)
      const formatCsvString = (str: string | string[] | Record<string, string> | null | undefined): string => {
        if (str === null || str === undefined) return '';
        let formattedStr: string;
        if (Array.isArray(str)) {
          formattedStr = str.join('; ');
        } else if (typeof str === 'object') { // For localStorage/sessionStorage
          formattedStr = Object.keys(str).join('; ');
        } else {
          formattedStr = String(str);
        }
        return `"${formattedStr.replace(/"/g, '""')}"`; // Escape double quotes and wrap in quotes
      };

      return [
        formatCsvString(node.url),
        formatCsvString(node.normalizedUrl),
        formatCsvString(node.title),
        node.statusCode || '',
        node.loadTime.toFixed(2),
        formatCsvString(node.errors),
        formatCsvString(node.csp),
        formatCsvString(node.forms),
        formatCsvString(node.consoleLogs),
        formatCsvString(node.cookies),
        formatCsvString(node.localStorage),
        formatCsvString(node.sessionStorage),
        formatCsvString(node.jsLinks)
      ].join(',');
    });

    await fs.writeFile(path.join(outputDir, 'crawl_data.csv'), [csvHeader, ...csvRows].join('\n'));
    console.log('[INFO] crawl_data.csv saved.');

    // Graphviz DOT output (visual representation of links)
    const dotNodes = this.graph.nodes.map((node, i) => {
        // Create unique ID for DOT node
        const nodeId = `n${i}_${node.normalizedUrl.substring(0, 8)}`;
        const label = `${node.url.substring(0, 70)}...\\nStatus: ${node.statusCode || 'N/A'}`; // Max 70 chars for label clarity
        return `  ${nodeId} [label="${label}", tooltip="${node.url}\\nTitle: ${node.title || 'N/A'}\\nStatus: ${node.statusCode || 'N/A'}", href="${node.url}"];`;
    }).join('\n');

    const dotEdges = this.graph.edges.map((edge) => {
        const sourceNode = this.graph.nodes.find(n => n.normalizedUrl === edge.source);
        const targetNode = this.graph.nodes.find(n => n.normalizedUrl === edge.target);

        if (!sourceNode || !targetNode) return ''; // Should not happen with normalized URLs

        const sourceIdx = this.graph.nodes.indexOf(sourceNode);
        const targetIdx = this.graph.nodes.indexOf(targetNode);

        const sourceId = `n${sourceIdx}_${sourceNode.normalizedUrl.substring(0, 8)}`;
        const targetId = `n${targetIdx}_${targetNode.normalizedUrl.substring(0, 8)}`;

        const color = edge.type === 'navigation' ? 'blue' : 'black';
        const style = edge.type === 'navigation' ? 'dashed' : 'solid';
        return `  ${sourceId} -> ${targetId} [label="${edge.type}", color="${color}", style="${style}"];`;
    }).join('\n');

    const dot = [
      'digraph CrawlGraph {',
      '  rankdir=LR;', // Left-to-right orientation
      '  node [shape=box, style="filled", fillcolor="#e0e0e0", fontname="Helvetica", fontsize=10];',
      '  edge [fontname="Helvetica", fontsize=9];',
      dotNodes,
      dotEdges,
      '}'
    ].join('\n');
    await fs.writeFile(path.join(outputDir, 'crawl_graph.dot'), dot);
    console.log('[INFO] crawl_graph.dot saved. Use Graphviz (dot command) to render.');
  }
}

// --- CLI Setup and Execution ---
program
  .option('--start-url <url>', 'Starting URL for the crawl', 'https://example.com')
  .option('--max-depth <number>', 'Maximum crawl depth (0 for only start URL, 1 for immediate links, etc.)', '3')
  .option('--concurrency <number>', 'Maximum number of concurrent browser pages/tabs', '5')
  .option('--politeness-delay <number>', 'Delay in milliseconds between initiating new page crawls to avoid overwhelming the server', '500')
  .option('--safe-click', 'Enable heuristics for clicking "load more" buttons and similar dynamic elements', false)
  .option('--scroll-mode', 'Enable infinite scroll handling (scrolls down a few times)', false)
  .option('--respect-sitemap', 'Parse robots.txt and sitemaps.xml to guide/prioritize crawling and respect disallow rules', false)
  .option('--extract-js-links', 'Extract all JavaScript file URLs (static and dynamically loaded) per page', false)
  .option('--output-dir <path>', 'Directory to save crawl results (JSON, CSV, DOT)', './crawl-output');

program.parse(process.argv);

const main = async () => {
  const options = program.opts();
  const config: CrawlConfig = {
    startUrl: options.startUrl,
    maxDepth: parseInt(options.maxDepth, 10),
    concurrency: parseInt(options.concurrency, 10),
    politenessDelay: parseInt(options.politenessDelay, 10),
    safeClick: options.safeClick,
    scrollMode: options.scrollMode,
    respectSitemap: options.respectSitemap,
    outputDir: options.outputDir,
    extractJsLinks: options.extractJsLinks,
  };

  // Input validation for start URL
  if (!config.startUrl.startsWith('http://') && !config.startUrl.startsWith('https://')) {
      console.error("[ERROR] Start URL must begin with 'http://' or 'https://'. Exiting.");
      process.exit(1);
  }
  // Input validation for numeric options
  if (isNaN(config.maxDepth) || config.maxDepth < 0 ||
      isNaN(config.concurrency) || config.concurrency < 1 ||
      isNaN(config.politenessDelay) || config.politenessDelay < 0) {
      console.error("[ERROR] Numeric options (--max-depth, --concurrency, --politeness-delay) must be valid non-negative numbers. --concurrency must be at least 1. Exiting.");
      process.exit(1);
  }


  console.log(`[INFO] Starting crawler with config:`, config);
  const crawler = new WebsiteCrawler(config);
  try {
    await crawler.initialize();
    await crawler.crawl();
    console.log('[COMPLETE] Crawler process finished.');
  } catch (error) {
    console.error(`[CRITICAL_ERROR] Crawler encountered a critical error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    // Ensure browser is closed even if an error occurs during initialization or crawl
    if (crawler['browser'] && crawler['browser'].isConnected()) {
        await crawler['browser'].close();
        console.log('[INFO] Browser closed.');
    }
  }
};

main().catch(error => {
    console.error(`[UNHANDLED_ERROR] An unhandled exception occurred: ${(error as Error).message}`);
    process.exit(1);
});