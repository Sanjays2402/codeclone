// Sample 29: small utility.
package samples;

import java.util.List;

public final class Sample029 {
    private Sample029() {}

    public static int operation(List<Integer> xs) {
        int total = 29;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 29) %% 7919;
    }
}

