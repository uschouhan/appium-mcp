import { FastMCP } from 'fastmcp/dist/FastMCP.js';
import { z } from 'zod';
import { getDriver } from '../../session-store.js';
import { generateAllElementLocators } from '../../locators/generate-all-locators.js';
import * as fs from 'fs';
import * as path from 'path';

export const checkLocatorsSchema = z.object({
  locatorFilePath: z.string().describe('Path to the JSON file containing locators to check'),
});

interface UserLocatorEntry {
  pageName: string;
  pageElementName: string;
  LocatorStrategy: string;
  Locators: string;
  fieldName: string;
  timestamp: string;
  remarks: string;
  AutoHeal: string;
}

interface ValidationResult {
  pageName: string;
  pageElementName: string;
  primaryStrategy: string;
  primaryLocator: string;
  found: boolean;
  alternateLocators?: Array<{ strategy: string; selector: string; tagName: string }>;
  error?: string;
}

export default function checkLocators(server: FastMCP): void {
  server.addTool({
    name: 'check_locators_from_file',
    description: 'Check locators from a file against the current emulator page and provide alternate locators if not found',
    parameters: checkLocatorsSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    execute: async (args: any, context: any): Promise<any> => {
      const driver = getDriver();
      if (!driver) {
        throw new Error('No active driver session. Please create a session first.');
      }

      try {
        // Read locators from file
        const locatorFilePath = path.resolve(args.locatorFilePath);
        if (!fs.existsSync(locatorFilePath)) {
          throw new Error(`Locator file not found: ${locatorFilePath}`);
        }

        const fileContent = fs.readFileSync(locatorFilePath, 'utf8');
        const userLocators: UserLocatorEntry[] = JSON.parse(fileContent);
        
        if (!Array.isArray(userLocators)) {
          throw new Error('Locator file must contain an array of locator objects');
        }

        // Get all locators from current page
        const pageSource = await driver.getPageSource();
        const driverName = (await driver.caps.automationName).toLowerCase();
        const allCurrentPageElements = generateAllElementLocators(
          pageSource,
          true,
          driverName
        );

        // Validate each locator
        const results: ValidationResult[] = [];
        
        for (const userLocator of userLocators) {
          try {
            // Attempt to find the element using the primary locator
            const element = await driver.findElement(userLocator.LocatorStrategy, userLocator.Locators);
            
            results.push({
              pageName: userLocator.pageName,
              pageElementName: userLocator.pageElementName,
              primaryStrategy: userLocator.LocatorStrategy,
              primaryLocator: userLocator.Locators,
              found: true
            });
          } catch (err: any) {
            // Element not found with primary locator, find alternate locators
            const alternateLocators = findAlternateLocators(
              userLocator,
              allCurrentPageElements
            );
            
            results.push({
              pageName: userLocator.pageName,
              pageElementName: userLocator.pageElementName,
              primaryStrategy: userLocator.LocatorStrategy,
              primaryLocator: userLocator.Locators,
              found: false,
              alternateLocators: alternateLocators,
              error: err.toString()
            });
          }
        }

        // Separate found and missing locators
        const foundLocators = results.filter(result => result.found);
        const missingLocators = results.filter(result => !result.found);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                totalChecked: results.length,
                foundCount: foundLocators.length,
                missingCount: missingLocators.length,
                foundLocators: foundLocators.map(loc => ({
                  pageName: loc.pageName,
                  pageElementName: loc.pageElementName,
                  strategy: loc.primaryStrategy,
                  selector: loc.primaryLocator
                })),
                missingLocators: missingLocators.map(loc => ({
                  pageName: loc.pageName,
                  pageElementName: loc.pageElementName,
                  primaryStrategy: loc.primaryStrategy,
                  primaryLocator: loc.primaryLocator,
                  alternateLocators: loc.alternateLocators,
                  error: loc.error
                })),
                message: `Checked ${results.length} locators: ${foundLocators.length} found, ${missingLocators.length} missing`
              }, null, 2)
            }
          ]
        };
      } catch (error: any) {
        throw new Error(`Failed to check locators: ${error.message}`);
      }
    },
  });
}

function findAlternateLocators(
  userLocator: UserLocatorEntry,
  allCurrentPageElements: any[]
): Array<{ strategy: string; selector: string; tagName: string }> {
  const alternates: Array<{ strategy: string; selector: string; tagName: string }> = [];
  
  // Look for elements with similar text or content
  const targetText = userLocator.fieldName || userLocator.remarks || userLocator.pageElementName;
  
  for (const element of allCurrentPageElements) {
    // Check if element has similar text/content
    const elementText = element.text || element.contentDesc || element.resourceId;
    if (elementText && targetText && elementText.toLowerCase().includes(targetText.toLowerCase())) {
      // Add all available locators for this matching element
      Object.entries(element.locators).forEach(([strategy, selector]) => {
        alternates.push({
          strategy,
          selector: selector as string,
          tagName: element.tagName
        });
      });
    }
    
    // Also check if any locator matches exactly
    Object.values(element.locators).forEach((selector: any) => {
      if (selector === userLocator.Locators) {
        Object.entries(element.locators).forEach(([strategy, sel]) => {
          if (strategy !== userLocator.LocatorStrategy) {
            alternates.push({
              strategy,
              selector: sel as string,
              tagName: element.tagName
            });
          }
        });
      }
    });
  }
  
  // Remove duplicates
  const uniqueAlternates = alternates.filter((item, index, self) =>
    index === self.findIndex(t => t.strategy === item.strategy && t.selector === item.selector)
  );
  
  return uniqueAlternates.slice(0, 5); // Return top 5 alternatives
}
