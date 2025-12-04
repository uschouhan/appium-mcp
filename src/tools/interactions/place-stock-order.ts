import { FastMCP } from 'fastmcp/dist/FastMCP.js';
import { z } from 'zod';
import { getDriver, getPlatformName } from '../../session-store.js';
import log from '../../logger.js';
import {
  generateAllElementLocators,
  ElementWithLocators,
} from '../../locators/generate-all-locators.js';

const placeStockOrderSchema = z.object({
  stockName: z
    .string()
    .min(1)
    .describe('Name of the stock to search for, e.g. "YESBANK"'),
  quantity: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('Quantity to buy. Defaults to 1.'),
});

// Helper to extract the element id from Appium / WebDriver responses
function getElementId(element: any): string {
  if (!element) {
    throw new Error('Element handle is undefined');
  }
  return (
    element.ELEMENT ??
    element['element-6066-11e4-a52e-4f735466cecf'] ??
    (() => {
      throw new Error('Unable to determine element id from element handle');
    })()
  );
}

// Prefer id/accessibility id/xpath strategies from generated locators
function pickBestLocator(element: ElementWithLocators): {
  strategy: string;
  selector: string;
} {
  const preferredOrder = ['id', 'accessibility id', 'xpath'];
  for (const key of preferredOrder) {
    if (element.locators[key]) {
      return { strategy: key, selector: element.locators[key] };
    }
  }
  const entries = Object.entries(element.locators);
  if (!entries.length) {
    throw new Error('No usable locators generated for target element');
  }
  const [strategy, selector] = entries[0];
  return { strategy, selector };
}

async function snapshotElements(driver: any): Promise<ElementWithLocators[]> {
  const pageSource = await driver.getPageSource();
  const automationName = (await driver.caps.automationName).toLowerCase();
  return generateAllElementLocators(pageSource, true, automationName);
}

async function findElementByPredicate(
  driver: any,
  predicate: (el: ElementWithLocators) => boolean,
  description: string
): Promise<{ elementId: string; strategy: string; selector: string }> {
  const elements = await snapshotElements(driver);
  const match = elements.find(predicate);
  if (!match) {
    throw new Error(`Unable to locate ${description} using generated locators`);
  }
  const { strategy, selector } = pickBestLocator(match);
  const handle = await driver.findElement(strategy, selector);
  const elementId = getElementId(handle);
  return { elementId, strategy, selector };
}

function textIncludes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default function placeStockOrder(server: FastMCP): void {
  server.addTool({
    name: 'appium_place_stock_order',
    description:
      'Place a delivery buy order for a given stock name on the currently opened Android trading app screen. ' +
      'Elements are located at runtime using generate_locators/page source: search field, first stock result, BUY, Delivery, Quantity, Place Buy Order, and Confirm.',
    parameters: placeStockOrderSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (args: any, context: any): Promise<any> => {
      const driver = getDriver();
      if (!driver) {
        throw new Error(
          'No active driver session. Please create a session first using create_session.'
        );
      }

      const platformName = getPlatformName(driver);
      if (platformName !== 'Android') {
        throw new Error(
          `appium_place_stock_order currently supports only Android. Detected platform: ${platformName}`
        );
      }

      const { stockName, quantity } = args as {
        stockName: string;
        quantity: number;
      };

      const steps: string[] = [];

      try {
        log.info(
          `Starting place stock order flow for "${stockName}" with quantity ${quantity}`
        );

        // 1. Find search bar using generated locators (looks for text/content-desc/resource-id with "search")
        steps.push('Locating search field via generated locators');
        const { elementId: searchFieldId } = await findElementByPredicate(
          driver,
          (el: ElementWithLocators) => {
            const hasSearchLabel =
              textIncludes(el.text, 'search') ||
              textIncludes(el.contentDesc, 'search') ||
              textIncludes(el.resourceId, 'search');
            const isInput =
              el.tagName.toLowerCase().includes('edittext') ||
              el.tagName.toLowerCase().includes('search');
            return hasSearchLabel && (el.clickable || isInput);
          },
          'search field'
        );

        steps.push(`Entering stock name "${stockName}" in search field`);
        await driver.setValue(stockName, searchFieldId);

        // Give time for search suggestions / results to appear
        await delay(2000);

        // 2. Click on 1st record of the result shown (matching stock name)
        steps.push('Locating first search result for stock via generated locators');
        const { elementId: firstResultId } = await findElementByPredicate(
          driver,
          (el: ElementWithLocators) =>
            !!el.text &&
            textIncludes(el.text, stockName) &&
            (el.clickable || el.tagName.toLowerCase().includes('textview')),
          `first search result for stock "${stockName}"`
        );

        steps.push('Clicking first matching search result');
        await driver.click(firstResultId);

        // Wait for stock details page to load
        await delay(2000);

        // 3. Click on BUY button
        steps.push('Locating BUY button via generated locators');
        const { elementId: buyButtonId } = await findElementByPredicate(
          driver,
          (el: ElementWithLocators) =>
            (equalsIgnoreCase(el.text, 'BUY') ||
              equalsIgnoreCase(el.contentDesc, 'BUY')) &&
            el.clickable,
          'BUY button'
        );

        steps.push('Clicking BUY button');
        await driver.click(buyButtonId);

        // Wait for order type screen
        await delay(2000);

        // 4. Click on Delivery
        steps.push('Locating Delivery option via generated locators');
        const { elementId: deliveryId } = await findElementByPredicate(
          driver,
          (el: ElementWithLocators) =>
            (equalsIgnoreCase(el.text, 'Delivery') ||
              equalsIgnoreCase(el.text, 'DELIVERY') ||
              equalsIgnoreCase(el.contentDesc, 'Delivery') ||
              equalsIgnoreCase(el.contentDesc, 'DELIVERY')) &&
            el.clickable,
          'Delivery option'
        );

        steps.push('Selecting Delivery');
        await driver.click(deliveryId);

        // Wait for quantity field to be ready
        await delay(1000);

        // 5. Find Quantity field and Clear and Enter Quantity
        steps.push('Locating Quantity field via generated locators');
        const { elementId: quantityFieldId, strategy: qtyStrategy, selector: qtySelector } =
          await findElementByPredicate(
            driver,
            (el: ElementWithLocators) => {
              const hasQtyHint =
                textIncludes(el.resourceId, 'qty') ||
                textIncludes(el.resourceId, 'quantity') ||
                textIncludes(el.text, 'Qty') ||
                textIncludes(el.contentDesc, 'Qty');
              const isInput =
                el.tagName.toLowerCase().includes('edittext') ||
                el.tagName.toLowerCase().includes('textfield');
              return hasQtyHint && (isInput || el.clickable);
            },
            'Quantity field'
          );
        log.info(
          `Using locator for Quantity field: strategy=${qtyStrategy}, selector=${qtySelector}`
        );

        steps.push('Clearing Quantity field (if supported)');
        try {
          if (typeof (driver as any).clear === 'function') {
            await (driver as any).clear(quantityFieldId);
          } else {
            // Fallback: set empty string to attempt clearing
            await driver.setValue('', quantityFieldId);
          }
        } catch (clearErr) {
          log.warn(
            `Failed to clear quantity field explicitly, proceeding to set value. Err: ${String(
              clearErr
            )}`
          );
        }

        const quantityStr = String(quantity);
        steps.push(`Setting quantity to ${quantityStr}`);
        await driver.setValue(quantityStr, quantityFieldId);

        // 6. Click Place Buy Order CTA
        steps.push('Locating Place Buy Order CTA via generated locators');
        const { elementId: placeBuyOrderId } = await findElementByPredicate(
          driver,
          (el: ElementWithLocators) => {
            const label = `${el.text} ${el.contentDesc}`.toLowerCase();
            return (
              label.includes('place') &&
              label.includes('buy') &&
              label.includes('order') &&
              el.clickable
            );
          },
          'Place Buy Order CTA'
        );

        steps.push('Clicking Place Buy Order CTA');
        await driver.click(placeBuyOrderId);

        // Wait for confirmation dialog
        await delay(2000);

        // 7. Click Confirm CTA
        steps.push('Locating Confirm CTA via generated locators');
        const { elementId: confirmId } = await findElementByPredicate(
          driver,
          (el: ElementWithLocators) =>
            (equalsIgnoreCase(el.text, 'Confirm') ||
              equalsIgnoreCase(el.contentDesc, 'Confirm')) &&
            el.clickable,
          'Confirm CTA'
        );

        steps.push('Clicking Confirm CTA to place order');
        await driver.click(confirmId);

        steps.push(
          `Successfully initiated delivery buy order for "${stockName}" with quantity ${quantityStr}`
        );
        log.info(
          `Completed place stock order flow for "${stockName}" with quantity ${quantity}`
        );

        return {
          content: [
            {
              type: 'text',
              text: steps.join(' -> '),
            },
          ],
        };
      } catch (err: any) {
        const message = `Failed to place stock order for "${stockName}". Last completed steps: ${steps.join(
          ' -> '
        )}. Error: ${err?.message || String(err)}`;
        log.error(message);
        throw new Error(message);
      }
    },
  });
}


