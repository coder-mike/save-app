# Simple Saving List

I've tried this a few times, but I'm going to try again. The key will be simplicity since I want to finish it quickly.

I want to recreate the old saving list program I created in highschool.

The basic idea is that you have a list of things you want, and money flows into the list in a top-down fashion.

Basically I'm thinking of the list like a progress bar that progresses downwards through the items on the list. We can use 2 colors (e.g. white and green) to indicate the progress through each item.

In the end, I also want to be able to reorder items on the list, and have them keep the money allocated to them.

I would also like to create multiple lists (probably just multiple app pages) to allocate different rates to them. The primary reason to avoid big purchases "clogging up" the progress.

I also have in mind to scale the list items visually according to their size. For example, we can say that the progress bar always progresses at x pixels per second down the screen. We can calculate then how many dollars per pixel there  are based on the rate of money configured to flow into the list. Then we can calculate the size of each list item according to their cost.

We may want the "x pixels per second" to be configurable per list, since some lists would be ones that we leave running in the background for a long time for large, infrequent purchases (e.g. anj iPhone) while others would be intended to for more frequent purchases.

Come to think of it, maybe we can use the average list item cost as a scaling factor. We can say that the average item should be 50 px high, and then scale everything else accordingly.

Or maybe rather than the average item, we scale according to the first item. I'm not sure. Or the first 3 items.

As with the original app, I want a dollar counter on each item showing how much is saved towards it, and I'll add some extra decimal places so you can really see it move and get the sense of progress.

I'll make this an electron app to start with, with the possibility of it being a web app in future.

## Internal Design

A list is just a data structure with:

  - A rate of money assigned to it
  - An overflow amount (dollar + rate)
  - A list of items

An "amount" here is a dollar figure with a timestamp and linear rate of change.

Each item has:

  - A name
  - A price
  - An amount saved for it (dollar + rate)

There are non-linearity points associated with:

  1. Adding or removing an item
  2. Re-ordering the list
  3. When an item is paid off

In between the non-linearity points, the progress of amounts is linear

The first 2 are user interventions and the third occurs in time.

If the user interacts with the system (e.g. modifying order, etc), we can capture the current values for the all the linear-changing amounts before executing the change.

Given a list, we can compute the amount of time until the next item is paid off (the next non-linearity if the user doesn't intervene) by looking at when the item will reach it's target. If the timestamp is in the past, we "capture" the state at the past time and then update to the new linear segment (e.g. applying the rate to the next item in the list)

I can think of a simplification to this model, which is just to have a single timestamp at the root.