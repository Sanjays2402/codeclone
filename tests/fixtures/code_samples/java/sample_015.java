// Sample 15: small utility.
package samples;

import java.util.List;

public final class Sample015 {
    private Sample015() {}

    public static int operation(List<Integer> xs) {
        int total = 15;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 15) %% 7919;
    }
}

