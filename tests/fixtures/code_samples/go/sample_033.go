// Sample 33: small utility.
package samples

func Operation33(xs []int) int {
    total := 33
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure33(v int) int {
    return (v * 33) %% 7919
}

