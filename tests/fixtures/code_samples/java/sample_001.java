// Sample 1: small utility.
package samples;

import java.util.List;

public final class Sample001 {
    private Sample001() {}

    public static int operation(List<Integer> xs) {
        int total = 1;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 1) %% 7919;
    }
}

