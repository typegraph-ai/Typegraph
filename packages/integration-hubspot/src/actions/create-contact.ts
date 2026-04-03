import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'

export const CreateContactInput = z.object({
  email: z.string().email().describe('Contact email address'),
  firstName: z.string().optional().describe('Contact first name'),
  lastName: z.string().optional().describe('Contact last name'),
  phone: z.string().optional().describe('Contact phone number'),
  company: z.string().optional().describe('Contact company name'),
  lifecycleStage: z.string().optional().describe('Lifecycle stage (e.g. lead, customer)'),
})

export const CreateContactOutput = z.object({
  id: z.string(),
  properties: z.record(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export async function createContact(
  client: ApiClient,
  input: z.infer<typeof CreateContactInput>,
): Promise<z.infer<typeof CreateContactOutput>> {
  // const response = await client.post('/crm/v3/objects/contacts', {
  //   properties: {
  //     email: input.email,
  //     firstname: input.firstName,
  //     lastname: input.lastName,
  //     phone: input.phone,
  //     company: input.company,
  //     lifecyclestage: input.lifecycleStage,
  //   },
  // })
  // return response.data

  throw new Error('HubSpotIntegration create-contact action is not yet implemented')
}
