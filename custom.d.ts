// custom.d.ts
declare module 'robots-txt-parser' {
  interface RobotsTxtInstance {
    canCrawl(url: string, userAgent: string): boolean;
    getSitemaps(): string[];
  }
  // تعریف می‌کنیم که default export این ماژول یک تابع به نام parseRobotsFn است
  // که در نهایت شیئی از نوع RobotsTxtInstance را برمی‌گرداند.
  function parseRobotsFn(url: string, content: string): RobotsTxtInstance;
  export default parseRobotsFn;
}